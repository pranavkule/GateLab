/**
 * P2.5.1: Redis-backed circuit breaker core.
 *
 * A per-BACKEND-INSTANCE circuit breaker whose state lives in Redis, so all
 * gateway processes observe and mutate the SAME circuit (they share nothing
 * else). Redis is the state store here for the same reason as the P2.4
 * rate-limit counters: shared mutable state across gateway processes is the
 * entire point.
 *
 * States:
 *   CLOSED     - requests permitted normally; consecutive failures counted.
 *   OPEN       - requests blocked until the cooldown expires (Retry-After).
 *   HALF-OPEN  - after the cooldown, only CB_HALF_OPEN_PROBES test requests
 *                are admitted (atomically, so concurrent gateways can never
 *                exceed the probe limit).
 *   CLOSED     - a successful HALF-OPEN probe closes the circuit again.
 * A failed HALF-OPEN probe reopens the circuit with a fresh cooldown.
 *
 * State machine operations are single Lua scripts (atomic in Redis):
 *   admit         - eligibility + OPEN->HALF-OPEN transition + probe
 *                   reservation in ONE round trip.
 *   recordFailure - consecutive-failure counting, threshold -> OPEN, failed
 *                   probe -> reopen.
 *   recordSuccess - success resets the consecutive counter; a HALF-OPEN
 *                   success closes the circuit.
 *   peek          - read-only eligibility (never consumes a probe slot),
 *                   used to filter round-robin candidates.
 *
 * Key: edgegate:cb:<backendPort> (hash: state, openedAt, failures, probes).
 * TTL protection: every write refreshes a safety TTL (>= 60 s), so state
 * from a crashed gateway or a dead backend port disappears on its own.
 *
 * Failure policy: fail-open. If Redis is unavailable or errors, the gateway
 * allows the request and logs a (throttled) warning - a Redis outage must
 * never take the gateway down.
 */
const CB_KEY_PREFIX = 'edgegate:cb:';

/**
 * Loads and validates circuit-breaker configuration from the environment.
 * Invalid values fall back to the documented defaults (safe defaults).
 */
function loadCircuitConfig(env = process.env) {
  function intOr(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
  }
  const failureThreshold = intOr(env.CB_FAILURE_THRESHOLD, 5, 1, 1000);
  const cooldownMs = intOr(env.CB_COOLDOWN_MS, 10000, 100, 3600000);
  const halfOpenProbes = intOr(env.CB_HALF_OPEN_PROBES, 1, 1, 100);
  return {
    failureThreshold,
    cooldownMs,
    halfOpenProbes,
    // Open/half-open state must OUTLIVE the cooldown so the lazy OPEN ->
    // HALF-OPEN transition happens through admit(), never by TTL expiry.
    safetyTtlMs: Math.max(cooldownMs * 4, 60000),
  };
}

// --- Lua: read-only eligibility check (never consumes a probe slot) --------
// Returns {eligible(0/1), retryAfterMs}
const CB_PEEK_LUA = `
local v = redis.call('HMGET', KEYS[1], 'state', 'openedAt', 'probes')
local s = v[1]
if not s or s == 'closed' then return {1, 0} end
local openedAt = tonumber(v[2]) or 0
local probes = tonumber(v[3]) or 0
if s == 'open' then
  if tonumber(ARGV[1]) < openedAt + tonumber(ARGV[2]) then
    return {0, openedAt + tonumber(ARGV[2]) - tonumber(ARGV[1])}
  end
  return {1, 0}
end
if probes < tonumber(ARGV[3]) then return {1, 0} end
return {0, 0}
`;

// --- Lua: admit a request (eligibility + transition + probe reservation) ---
// Returns {allowed(0/1), state, retryAfterMs}
const CB_ADMIT_LUA = `
local s = redis.call('HGET', KEYS[1], 'state')
if not s or s == 'closed' then return {1, 'closed', 0} end
if s == 'open' then
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt')) or 0
  if tonumber(ARGV[1]) < openedAt + tonumber(ARGV[2]) then
    return {0, 'open', openedAt + tonumber(ARGV[2]) - tonumber(ARGV[1])}
  end
  -- cooldown expired: OPEN -> HALF-OPEN, reserve the first probe slot
  redis.call('HSET', KEYS[1], 'state', 'half-open', 'probes', '1')
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return {1, 'half-open', 0}
end
-- half-open: admit only up to the configured number of probes
local probes = tonumber(redis.call('HGET', KEYS[1], 'probes')) or 0
if probes < tonumber(ARGV[3]) then
  redis.call('HINCRBY', KEYS[1], 'probes', 1)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return {1, 'half-open', 0}
end
return {0, 'half-open', 0}
`;

// --- Lua: record a failed outcome ------------------------------------------
// Returns {level, state, retryAfterMs}; level: 1 still-closed, 2 open
const CB_FAILURE_LUA = `
local s = redis.call('HGET', KEYS[1], 'state')
if s == 'open' then
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt')) or 0
  return {2, 'open', math.max(0, openedAt + tonumber(ARGV[3]) - tonumber(ARGV[1]))}
end
if s == 'half-open' then
  -- failed probe: reopen with a fresh cooldown, clear stale probe slots
  redis.call('HSET', KEYS[1], 'state', 'open', 'openedAt', ARGV[1], 'probes', '0', 'failures', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return {2, 'open', tonumber(ARGV[3])}
end
-- closed (or no state): count consecutive failures
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('HSET', KEYS[1], 'state', 'closed')
if failures >= tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'state', 'open', 'openedAt', ARGV[1])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return {2, 'open', tonumber(ARGV[3])}
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {1, 'closed', 0}
`;

// --- Lua: record a successful outcome --------------------------------------
// Returns {level, state, retryAfterMs}; level: 1 ok, 2 open (unexpected), 3 closed
const CB_SUCCESS_LUA = `
local s = redis.call('HGET', KEYS[1], 'state')
if s == 'half-open' then
  -- successful probe: close the circuit and clear all counters
  redis.call('DEL', KEYS[1])
  return {3, 'closed', 0}
end
if s == 'open' then
  -- traffic succeeded while OPEN (should not happen through the gateway
  -- flow): report open but never auto-close from here
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt')) or 0
  return {2, 'open', math.max(0, openedAt + tonumber(ARGV[2]) - tonumber(ARGV[1]))}
end
-- closed: reset the consecutive-failure counter only if one exists
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures')) or 0
if failures > 0 then redis.call('DEL', KEYS[1]) end
return {1, 'closed', 0}
`;

// --- Lua: reset one circuit -------------------------------------------------
const CB_RESET_LUA = `
redis.call('DEL', KEYS[1])
return 1
`;

function keyFor(port) {
  return `${CB_KEY_PREFIX}${Number(port)}`;
}

/**
 * Flushes ONLY the circuit-breaker namespace (used by /api/reset and tests).
 * Returns the number of keys removed.
 */
async function clearCircuitKeys(redis) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${CB_KEY_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length) await redis.del(...keys);
  return keys.length;
}

/**
 * Creates a circuit-breaker client bound to one Redis connection.
 * Every gateway process creates its own instance - the STATE is shared
 * through Redis, the connections are not.
 */
function createCircuitBreaker({ redis, name = 'gateway', config } = {}) {
  const cfg = config || loadCircuitConfig();
  let lastWarn = 0;

  function warnThrottled(operation, message) {
    const now = Date.now();
    if (now - lastWarn >= 5000) {
      lastWarn = now;
      console.warn(`[${name}] circuit-breaker fail-open (${operation}): ${message}`);
    }
  }

  function argv(...extra) {
    return [String(Date.now()), String(cfg.cooldownMs), String(cfg.halfOpenProbes), String(cfg.safetyTtlMs), ...extra];
  }

  // Effective state: an OPEN circuit whose cooldown has expired is already
  // HALF-OPEN for monitoring purposes (the transition itself is performed
  // lazily and atomically by admit()).
  function effectiveState(stored, openedAt) {
    if (!stored || stored === 'closed') return 'closed';
    if (stored === 'open') {
      return Date.now() < openedAt + cfg.cooldownMs ? 'open' : 'half-open';
    }
    return 'half-open';
  }

  // Read-only eligibility for round-robin candidate filtering. Never
  // consumes a probe slot. Fail-open: every candidate eligible.
  async function peekEligible(port) {
    try {
      const r = await redis.eval(CB_PEEK_LUA, 1, keyFor(port), ...argv());
      return { eligible: Number(r[0]) === 1, retryAfterMs: Number(r[1]) || 0 };
    } catch (err) {
      warnThrottled('peek', err.message || 'Redis unavailable');
      return { eligible: true, retryAfterMs: 0 };
    }
  }

  async function filterEligible(ports) {
    const eligible = [];
    const blocked = [];
    await Promise.all((ports || []).map(async (port) => {
      const { eligible: ok, retryAfterMs } = await peekEligible(port);
      if (ok) eligible.push(port);
      else blocked.push({ port, retryAfterMs });
    }));
    return { eligible, blocked };
  }

  // Commit a candidate for forwarding: performs the OPEN -> HALF-OPEN
  // transition and atomically reserves a probe slot. Concurrent gateways
  // can never exceed CB_HALF_OPEN_PROBES admissions.
  async function admit(port) {
    try {
      const r = await redis.eval(CB_ADMIT_LUA, 1, keyFor(port), ...argv());
      return { allowed: Number(r[0]) === 1, state: String(r[1]), retryAfterMs: Number(r[2]) || 0 };
    } catch (err) {
      warnThrottled('admit', err.message || 'Redis unavailable');
      return { allowed: true, state: 'closed', retryAfterMs: 0 };
    }
  }

  async function recordFailure(port) {
    try {
      const r = await redis.eval(CB_FAILURE_LUA, 1, keyFor(port), String(Date.now()), String(cfg.failureThreshold), String(cfg.cooldownMs), String(cfg.safetyTtlMs));
      return { level: Number(r[0]), state: String(r[1]), retryAfterMs: Number(r[2]) || 0 };
    } catch (err) {
      warnThrottled('recordFailure', err.message || 'Redis unavailable');
      return { level: 0, state: 'closed', retryAfterMs: 0 };
    }
  }

  async function recordSuccess(port) {
    try {
      const r = await redis.eval(CB_SUCCESS_LUA, 1, keyFor(port), String(Date.now()), String(cfg.cooldownMs));
      return { level: Number(r[0]), state: String(r[1]), retryAfterMs: Number(r[2]) || 0 };
    } catch (err) {
      warnThrottled('recordSuccess', err.message || 'Redis unavailable');
      return { level: 0, state: 'closed', retryAfterMs: 0 };
    }
  }

  async function status(port) {
    try {
      const v = await redis.hmget(keyFor(port), 'state', 'openedAt', 'failures', 'probes');
      const stored = v[0];
      const openedAt = Number(v[1]) || 0;
      const state = effectiveState(stored, openedAt);
      return {
        port: Number(port),
        state,
        storedState: stored || 'closed',
        failures: Number(v[2]) || 0,
        probes: Number(v[3]) || 0,
        retryAfterMs: state === 'open' ? Math.max(0, openedAt + cfg.cooldownMs - Date.now()) : 0,
      };
    } catch (err) {
      warnThrottled('status', err.message || 'Redis unavailable');
      return { port: Number(port), state: 'closed', storedState: 'closed', failures: 0, probes: 0, retryAfterMs: 0 };
    }
  }

  async function statusAll(ports) {
    const list = await Promise.all((ports || []).map((p) => status(p)));
    const map = {};
    for (const s of list) map[s.port] = s;
    return map;
  }

  async function reset(port) {
    try {
      await redis.eval(CB_RESET_LUA, 1, keyFor(port));
      return true;
    } catch (err) {
      warnThrottled('reset', err.message || 'Redis unavailable');
      return false;
    }
  }

  async function resetAll() {
    try {
      return await clearCircuitKeys(redis);
    } catch (err) {
      warnThrottled('resetAll', err.message || 'Redis unavailable');
      return 0;
    }
  }

  return {
    config: cfg,
    peekEligible,
    filterEligible,
    admit,
    recordSuccess,
    recordFailure,
    status,
    statusAll,
    reset,
    resetAll,
  };
}

module.exports = {
  CB_KEY_PREFIX,
  loadCircuitConfig,
  createCircuitBreaker,
  clearCircuitKeys,
};
