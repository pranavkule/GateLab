/**
 * Authentication endpoint throttling (P2.6.1).
 *
 * Redis-backed fixed window (same Lua primitive as the gateway rate limiter)
 * applied to /auth/login, /auth/register and /auth/customer-login. Identity is
 * the resolved client IP (trusted-proxy aware, shared helper with the entry
 * LB). Separate budgets for login and registration. Responses mirror the P2.4
 * contract: 429 + Retry-After + X-RateLimit-* headers.
 *
 * In production, Redis failures reject authentication with 503. Development
 * remains fail-open so local work is not blocked by an unavailable Redis.
 */
const { resolveClientIp } = require('../security/trustedProxy');

const AUTH_THROTTLE_KEY_PREFIX = 'edgegate:atl:';

// Atomic fixed window: [count, ttlMs] - identical to rateLimit.js
const AUTH_THROTTLE_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

function authThrottleEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Create the throttle middleware.
 * @param {object} opts
 * @param {object|null} opts.redis shared Redis connection (null disables)
 * @param {string} opts.kind 'login' | 'register'
 * @param {number} [opts.limit] overrides AUTH_LOGIN_RATE_LIMIT / AUTH_REGISTER_RATE_LIMIT
 * @param {number} [opts.windowMs] overrides AUTH_RATE_WINDOW_MS
 */
function createAuthThrottleMiddleware({ redis, kind, limit, windowMs } = {}) {
  const max = Number.isFinite(limit) && limit > 0
    ? limit
    : authThrottleEnv(kind === 'register' ? 'AUTH_REGISTER_RATE_LIMIT' : 'AUTH_LOGIN_RATE_LIMIT', 10);
  const window = Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : authThrottleEnv('AUTH_RATE_WINDOW_MS', 300000);
  const failClosed = process.env.NODE_ENV === 'production';
  let warnCount = 0;

  return async function authThrottle(req, res, next) {
    function handleUnavailable(reason) {
      if ((warnCount += 1) <= 3 || warnCount % 50 === 0) {
        console.warn(`[auth-throttle] ${reason}; ${failClosed ? 'rejecting authentication' : 'failing open'} (total=${warnCount})`);
      }
      if (failClosed) {
        res.status(503).json({
          error: 'service_unavailable',
          message: 'Authentication temporarily unavailable',
        });
        return;
      }
      next();
    }

    if (!redis || !max) {
      handleUnavailable('Redis connection unavailable');
      return;
    }
    const clientIp = resolveClientIp(req);
    const key = `${AUTH_THROTTLE_KEY_PREFIX}${kind}:${clientIp}`;
    try {
      const result = await redis.eval(AUTH_THROTTLE_LUA, 1, key, String(window));
      const count = Number(Array.isArray(result) ? result[0] : result);
      const ttl = Number(Array.isArray(result) ? result[1] : 0);
      if (!Number.isFinite(count)) {
        handleUnavailable('Unexpected Redis response');
        return;
      }
      const remaining = Math.max(0, max - count);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Date.now() + Math.max(0, ttl)));
      if (count > max) {
        const retryAfterSec = Math.max(1, Math.ceil(ttl / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          error: 'rate_limited',
          message: `Too many ${kind} attempts. Try again in ${retryAfterSec}s.`,
          retryAfterMs: Math.max(0, ttl),
        });
        return;
      }
      next();
    } catch (err) {
      handleUnavailable('Redis unavailable');
    }
  };
}

/** Clear all authentication throttle keys (used by /api/reset + tests). */
async function clearAuthThrottleKeys(redis) {
  if (!redis) return 0;
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${AUTH_THROTTLE_KEY_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length) await redis.del(...keys);
  return keys.length;
}

module.exports = {
  AUTH_THROTTLE_KEY_PREFIX,
  createAuthThrottleMiddleware,
  clearAuthThrottleKeys,
};
