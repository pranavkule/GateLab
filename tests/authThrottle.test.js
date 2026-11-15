/**
 * TEST SUITE (P2.6.1): authentication endpoint throttling.
 *
 * Two layers:
 *   1. In-process Express apps exercising the middleware with an isolated
 *      in-memory Redis-compatible fake - deterministic 429s,
 *      per-kind budgets, per-IP isolation, window expiry, fail-open behaviour.
 *   2. Stack-level checks against auth :15001 (limits from tests/stackRunner.js)
 *      proving the middleware is mounted and that Lab Reset (/api/reset)
 *      clears the edgegate:atl:* namespace.
 *
 * Trust model: supertest clients connect from loopback (a trusted peer), so
 * an explicit X-Real-IP header simulates arbitrary client IPs behind nginx.
 */
const request = require('supertest');
const express = require('express');
const Redis = require('ioredis');
const {
  createAuthThrottleMiddleware,
  clearAuthThrottleKeys,
  AUTH_THROTTLE_KEY_PREFIX,
} = require('../backend/middleware/authThrottle');
const { getTestRedisUrl } = require('./testTargetSafety');

const TEST_REDIS = getTestRedisUrl();
const AUTH = 'http://localhost:15001';
const CP = 'http://localhost:15000';

function createMemoryRedis() {
  const entries = new Map();
  return {
    async eval(_script, _keyCount, key, windowMs) {
      const now = Date.now();
      let entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) {
        entry = { count: 0, expiresAt: now + Number(windowMs) };
      }
      entry.count += 1;
      entries.set(key, entry);
      return [entry.count, Math.max(0, entry.expiresAt - now)];
    },
    async scan(_cursor, _match, pattern) {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
      }
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return ['0', [...entries.keys()].filter((key) => key.startsWith(prefix))];
    },
    async del(...keys) {
      let removed = 0;
      keys.forEach((key) => { if (entries.delete(key)) removed += 1; });
      return removed;
    },
    async set(key, value) {
      entries.set(key, { count: String(value), expiresAt: Infinity });
      return 'OK';
    },
    async get(key) {
      const entry = entries.get(key);
      return entry ? String(entry.count) : null;
    },
    async quit() {},
  };
}

const redis = createMemoryRedis();
let stackRedis;

function getStackRedis() {
  if (!stackRedis) stackRedis = new Redis(TEST_REDIS);
  return stackRedis;
}

function appWith(redisConn, kind, limit, windowMs) {
  const app = express();
  app.use(express.json());
  app.post('/target', createAuthThrottleMiddleware({ redis: redisConn, kind, limit, windowMs }), (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function withTrustedProxies(value, run) {
  const previous = process.env.TRUSTED_PROXIES;
  process.env.TRUSTED_PROXIES = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = previous;
  }
}

afterAll(async () => {
  try { await clearAuthThrottleKeys(redis); } catch (_) {}
  if (stackRedis) {
    try { await stackRedis.quit(); } catch (_) {}
  }
});

describe('Auth throttle middleware (P2.6.1) - in-process', () => {
  test('allows up to the limit, then 429 with Retry-After and rate-limit headers', async () => {
    const app = appWith(redis, 'login', 2, 5000);
    const ok = await request(app).post('/target').set('X-Real-IP', '198.51.100.1');
    expect(ok.status).toBe(200);
    expect(ok.headers['x-ratelimit-limit']).toBe('2');
    expect(ok.headers['x-ratelimit-remaining']).toBe('1');
    const second = await request(app).post('/target').set('X-Real-IP', '198.51.100.1');
    expect(second.status).toBe(200);
    const blocked = await request(app).post('/target').set('X-Real-IP', '198.51.100.1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.body.message).toContain('login');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now());
  });

  test('different client IPs have independent budgets (trusted proxy identity)', async () => {
    const app = appWith(redis, 'login', 1, 5000);
    await request(app).post('/target').set('X-Real-IP', '198.51.100.2');
    const blocked = await request(app).post('/target').set('X-Real-IP', '198.51.100.2');
    expect(blocked.status).toBe(429);
    const other = await request(app).post('/target').set('X-Real-IP', '198.51.100.3');
    expect(other.status).toBe(200);
  });

  test('Auth throttling ignores forwarded headers from an untrusted peer', async () => {
    await withTrustedProxies('172.30.250.2', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '198.51.100.40' });
        next();
      });
      app.post('/target', createAuthThrottleMiddleware({
        redis,
        kind: 'login',
        limit: 1,
        windowMs: 5000,
      }), (_req, res) => res.json({ ok: true }));

      const first = await request(app).post('/target').set('X-Real-IP', '203.0.113.40');
      expect(first.status).toBe(200);
      const spoofed = await request(app).post('/target').set('X-Real-IP', '203.0.113.41');
      expect(spoofed.status).toBe(429);
    });
  });

  test('login and registration have separate budgets', async () => {
    const loginApp = appWith(redis, 'login', 1, 5000);
    const registerApp = appWith(redis, 'register', 1, 5000);
    const loginAllowed = await request(loginApp).post('/target').set('X-Real-IP', '198.51.100.4');
    expect(loginAllowed.status).toBe(200);
    const loginBlocked = await request(loginApp).post('/target').set('X-Real-IP', '198.51.100.4');
    expect(loginBlocked.status).toBe(429);
    const registerAllowed = await request(registerApp).post('/target').set('X-Real-IP', '198.51.100.4');
    expect(registerAllowed.status).toBe(200);
    const registerBlocked = await request(registerApp).post('/target').set('X-Real-IP', '198.51.100.4');
    expect(registerBlocked.status).toBe(429);
    const registerFreshIp = await request(registerApp).post('/target').set('X-Real-IP', '198.51.100.5');
    expect(registerFreshIp.status).toBe(200);
  });

  test('window expiry restores the budget', async () => {
    const app = appWith(redis, 'login', 1, 400);
    await request(app).post('/target').set('X-Real-IP', '198.51.100.6');
    const blocked = await request(app).post('/target').set('X-Real-IP', '198.51.100.6');
    expect(blocked.status).toBe(429);
    await new Promise((r) => setTimeout(r, 700));
    const again = await request(app).post('/target').set('X-Real-IP', '198.51.100.6');
    expect(again.status).toBe(200);
  });

  test('fail-open: Redis errors let requests through', async () => {
    const broken = { eval: async () => { throw new Error('connection down'); } };
    const app = appWith(broken, 'login', 1, 5000);
    const res = await request(app).post('/target').set('X-Real-IP', '198.51.100.7');
    expect(res.status).toBe(200);
    const again = await request(app).post('/target').set('X-Real-IP', '198.51.100.7');
    expect(again.status).toBe(200);
  });

  test('fail-open by construction: no Redis connection disables throttling', async () => {
    const app = appWith(null, 'login', 1, 5000);
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/target').set('X-Real-IP', '198.51.100.8');
      expect(res.status).toBe(200);
    }
  });
});

describe('clearAuthThrottleKeys (P2.6.1)', () => {
  test('removes only the edgegate:atl:* namespace', async () => {
    await clearAuthThrottleKeys(redis);
    await redis.set(`${AUTH_THROTTLE_KEY_PREFIX}login:198.51.100.9`, '1');
    await redis.set(`${AUTH_THROTTLE_KEY_PREFIX}register:198.51.100.9`, '1');
    await redis.set('edgegate:rl:untouched', '1');
    const removed = await clearAuthThrottleKeys(redis);
    expect(removed).toBe(2);
    const remaining = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${AUTH_THROTTLE_KEY_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      if (Array.isArray(batch)) remaining.push(...batch);
    } while (cursor !== '0');
    expect(remaining.length).toBe(0);
    expect(await redis.get('edgegate:rl:untouched')).toBe('1');
    await redis.del('edgegate:rl:untouched');
  });
});

describe('Auth throttle on the test stack (P2.6.1)', () => {
  test('customer-login responses carry throttle headers (middleware mounted)', async () => {
    const res = await fetch(`${AUTH}/auth/customer-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'definitely-wrong' }),
    });
    // Credentials are wrong, but the middleware ran before the handler.
    expect(res.status).toBe(401);
    expect(res.headers.get('x-ratelimit-limit')).toBe('25');
  });

  test('register responses carry throttle headers (middleware mounted)', async () => {
    const res = await fetch(`${AUTH}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ThrottleProbe', email: '', password: 'short' }),
    });
    // Validation error, but the middleware ran before the handler.
    expect(res.status).toBe(400);
    expect(res.headers.get('x-ratelimit-limit')).toBe('25');
  });

  test('Lab Reset clears authentication throttle keys', async () => {
    const key = `${AUTH_THROTTLE_KEY_PREFIX}login:203.0.113.99`;
    const stack = getStackRedis();
    await stack.set(key, '3');
    const tokenRes = await fetch(`${CP}/api/demo-token?type=valid`);
    const { token } = await tokenRes.json();
    const reset = await fetch(`${CP}/api/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    expect(reset.ok).toBe(true);
    const body = await reset.json();
    expect(body.message).toContain('auth-throttle');
    const count = await stack.get(key);
    expect(count).toBe(null);
  });
});
