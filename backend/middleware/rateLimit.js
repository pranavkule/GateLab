/**
 * Gateway rate-limit middleware (P2.4).
 *
 * Fixed-window rate limiting with SHARED counters in Redis, so the limit is
 * enforced globally across all gateway instances (they share nothing else).
 *
 * Algorithm (one Redis round trip per limited request, via Lua):
 *   INCR key; PEXPIRE key windowMs when the counter is new; PTTL key.
 * The counter is scoped by (config version, route id, client identity), so a
 * freshly applied configuration starts with a clean budget and old windows
 * expire by TTL automatically.
 *
 * Identity:
 *   - authenticated routes: the verified JWT subject (req.user.sub, set by
 *     the JWT middleware - never a client-supplied header).
 *   - public routes: the trusted client IP. The entry load balancer
 *     OVERWRITES X-Forwarded-For with the connecting socket address, so the
 *     gateway's single-hop XFF value cannot be forged by clients; direct
 *     gateway clients fall back to the remote address.
 *
 * Failure policy: fail-open. If Redis is unavailable or errors, requests are
 * allowed through and a (throttled) warning is logged. Availability is
 * preferred over strictness; see docs/architecture.md for the trade-off.
 *
 * Ordering: mounted AFTER the JWT middleware, so missing/invalid JWTs still
 * receive the existing 401 and are not consumed by a 429.
 */
const registry = require('../registry');

const RATE_LIMIT_KEY_PREFIX = 'edgegate:rl:';

// Atomic fixed window: [count, ttlMs]
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

// Normalize IPv4-mapped IPv6 and IPv6 loopback to a plain IPv4 string so the
// same client always maps to the same bucket.
function normalizeClientIp(raw) {
  if (!raw) return 'unknown';
  let ip = String(raw).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.toLowerCase();
}

// Key parts must never contain ':' (the namespace separator).
function keyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function clientIdentity(req, route) {
  if (route.authRequired && req.jwtStatus === 'valid' && req.user && req.user.sub) {
    return `u:${keyPart(req.user.sub)}`;
  }
  // Trust model: the entry LB overwrites X-Forwarded-For; the first (only)
  // value is therefore the real connecting address for proxied traffic.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return `ip:${keyPart(normalizeClientIp(xff.split(',')[0].trim()))}`;
  }
  return `ip:${keyPart(normalizeClientIp(req.socket && req.socket.remoteAddress))}`;
}

function retryAfterSeconds(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 1;
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/**
 * Flushes ONLY the rate-limit namespace (used by /api/reset and tests).
 * Returns the number of keys removed.
 */
async function clearRateLimitKeys(redis) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${RATE_LIMIT_KEY_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length) await redis.del(...keys);
  return keys.length;
}

function createRateLimitMiddleware({ getRouteForPath, redis, gatewayName = 'gateway' }) {
  let lastWarn = 0;
  function warnThrottled(message) {
    const now = Date.now();
    if (now - lastWarn >= 5000) {
      lastWarn = now;
      console.warn(`[${gatewayName}] rate-limit fail-open: ${message}`);
    }
  }

  return async function rateLimitMiddleware(req, res, next) {
    let route;
    try {
      route = getRouteForPath(req.path);
    } catch (_) { route = null; }
    const rl = route && route.rateLimit;
    if (!rl || !(rl.limit > 0) || !(rl.windowMs > 0)) return next();

    const identity = clientIdentity(req, route);
    const version = registry.state.configVersion || 0;
    const key = `${RATE_LIMIT_KEY_PREFIX}v${version}:${keyPart(route.id)}:${identity}`;

    let result;
    try {
      result = await redis.eval(RATE_LIMIT_LUA, 1, key, String(rl.windowMs));
    } catch (err) {
      warnThrottled(err.message || 'Redis unavailable');
      return next();
    }

    const count = Number(Array.isArray(result) ? result[0] : result);
    const ttlMs = Number(Array.isArray(result) ? result[1] : 0);
    if (!Number.isFinite(count)) {
      warnThrottled('unexpected Redis response');
      return next();
    }

    res.set('X-RateLimit-Limit', String(rl.limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, rl.limit - count)));
    res.set('X-RateLimit-Reset', String(Date.now() + Math.max(0, ttlMs)));

    if (count <= rl.limit) return next();

    // Limit exceeded: clean 429 short-circuit. The universal request logger
    // publishes the record on 'finish' (res.locals.logged stays false) and
    // marks it via res.locals.rateLimited.
    const started = Date.now();
    res.locals = res.locals || {};
    res.locals.rateLimited = true;
    registry.trackRequest(Date.now() - started, 429, req.jwtStatus, true);
    return res
      .status(429)
      .set('Retry-After', String(retryAfterSeconds(ttlMs)))
      .json({
        error: 'rate_limited',
        message: `Rate limit exceeded: maximum ${rl.limit} requests per ${Math.round(rl.windowMs / 1000)}s for this route. Retry later.`,
        retryAfterMs: Math.max(0, ttlMs),
      });
  };
}

module.exports = {
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_LUA,
  createRateLimitMiddleware,
  clearRateLimitKeys,
  normalizeClientIp,
  clientIdentity,
};
