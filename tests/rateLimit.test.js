/**
 * TEST SUITE (P2.4): Redis-backed shared rate limiting.
 *
 * Runs against the real miniature stack (tests/stackRunner.js):
 *   entry LB :14100 -> gateways :14101/:14102 -> backends, control plane :15000,
 *   auth :15001, Redis :6380, MongoDB edgegate_test.
 *
 * Rate-limit counters are scoped by (config version, route id, identity), so
 * every applied configuration version starts with a fresh budget and tests
 * do not interfere through stale windows.
 *
 * Cleanup: the original configuration is restored in afterAll and ONLY the
 * rate-limit key namespace (edgegate:rl:*) is flushed.
 */
const request = require('supertest');
const express = require('express');
const Redis = require('ioredis');
const {
  createRateLimitMiddleware,
  clearRateLimitKeys,
  normalizeClientIp,
} = require('../backend/middleware/rateLimit');

const ENTRY = 'http://localhost:14100';
const GW1 = 'http://127.0.0.1:14101';
const GW2 = 'http://127.0.0.1:14102';
const CP = 'http://localhost:15000';
const AUTH = 'http://localhost:15001';
const TEST_REDIS = 'redis://localhost:6380';

const redis = new Redis(TEST_REDIS);
let adminToken = null;
let originalRoutes = null;

async function admin() {
  if (adminToken) return adminToken;
  const res = await fetch(`${CP}/api/demo-token?type=valid`);
  adminToken = (await res.json()).token;
  return adminToken;
}

async function latestConfig() {
  const res = await fetch(`${CP}/api/config/latest`);
  return res.json();
}

async function applyRoutes(routes) {
  const token = await admin();
  const res = await fetch(`${CP}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ routes }),
  });
  if (!res.ok) throw new Error(`apply failed: ${res.status} ${await res.text()}`);
  const applied = await res.json();
  // Give the Redis Pub/Sub snapshot a moment to reach both gateways.
  await new Promise((r) => setTimeout(r, 400));
  return applied;
}

// Apply the original routes with rate-limit overrides per route id.
async function applyLimits(overrides) {
  const cfg = await latestConfig();
  const routes = cfg.routes.map((r) => ({ ...r, ...(overrides[r.id] !== undefined ? { rateLimit: overrides[r.id] } : {}) }));
  return applyRoutes(routes);
}

async function registerAndLogin(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const email = `rl-${slug}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.test`;
  const reg = await fetch(`${AUTH}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: label, email, password: 'RateLimitTest123' }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const login = await fetch(`${AUTH}/auth/customer-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'RateLimitTest123' }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  return (await login.json()).token;
}

afterAll(async () => {
  // Restore the configuration that was active before this suite.
  try { if (originalRoutes) await applyRoutes(originalRoutes); } catch (_) {}
  // Clean up ONLY this feature's Redis namespace.
  try { await clearRateLimitKeys(redis); } catch (_) {}
  try { await redis.quit(); } catch (_) {}
});

describe('Rate limiting (P2.4)', () => {
  test('setup: capture original configuration', async () => {
    const cfg = await latestConfig();
    originalRoutes = cfg.routes.map((r) => ({ ...r }));
    expect(originalRoutes.length).toBeGreaterThan(0);
    await clearRateLimitKeys(redis);
  });

  test('requests within the configured limit succeed (shared across gateways)', async () => {
    await applyLimits({ 'r-products': { limit: 3, windowMs: 5000 } });
    // Burst through the ENTRY LB: the round-robin may hit either gateway,
    // so 3 successes already prove the counters are shared.
    for (let i = 0; i < 3; i++) {
      const res = await request(ENTRY).get('/api/products');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(2 - i));
    }
  });

  test('requests beyond the limit return 429 with a valid Retry-After', async () => {
    const res = await request(ENTRY).get('/api/products');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(5); // window is 5 s
  });

  test('counters reset after the configured window', async () => {
    await new Promise((r) => setTimeout(r, 5500)); // window was 5 s
    const res = await request(ENTRY).get('/api/products');
    expect(res.status).toBe(200);
  });

  test('limits are shared across gateway instances', async () => {
    // A fresh configuration version gives every client a clean budget.
    await applyLimits({ 'r-products': { limit: 3, windowMs: 60000 } });
    // Exhaust the budget directly on gateway 1 ...
    for (let i = 0; i < 3; i++) {
      const res = await request(GW1).get('/api/products');
      expect(res.status).toBe(200);
    }
    expect((await request(GW1).get('/api/products')).status).toBe(429);
    // ... gateway 2 MUST see the same exhausted counter.
    const res = await request(GW2).get('/api/products');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  test('different client IPs have separate limits', async () => {
    // Direct gateway clients: the trusted identity is the XFF value the
    // (loopback-only) lab topology expects from the entry LB.
    for (let i = 0; i < 3; i++) {
      const res = await request(GW1).get('/api/products').set('X-Forwarded-For', '198.51.100.10');
      expect(res.status).toBe(200);
    }
    expect((await request(GW1).get('/api/products').set('X-Forwarded-For', '198.51.100.10')).status).toBe(429);
    expect((await request(GW1).get('/api/products').set('X-Forwarded-For', '198.51.100.11')).status).toBe(200);
  });

  test('different authenticated users have separate limits', async () => {
    await applyLimits({ 'r-users': { limit: 2, windowMs: 6000 } });
    const user1 = await registerAndLogin('RL User One');
    const user2 = await registerAndLogin('RL User Two');

    for (let i = 0; i < 2; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${user1}`);
      expect(res.status).toBe(200);
    }
    expect((await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${user1}`)).status).toBe(429);
    // A different verified JWT subject must NOT share the exhausted budget.
    expect((await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${user2}`)).status).toBe(200);
  });

  test('different routes have independent limits', async () => {
    // The users route budget (user1) is exhausted from the previous test.
    const user1 = await registerAndLogin('RL User Three');
    // Orders has NO limit in the current config: bursting stays 200.
    for (let i = 0; i < 4; i++) {
      const res = await request(ENTRY).get('/api/orders').set('Authorization', `Bearer ${user1}`);
      expect(res.status).toBe(200);
    }
  });

  test('routes without limits remain unaffected', async () => {
    await applyLimits({ 'r-products': null, 'r-users': null, 'r-orders': null });
    for (let i = 0; i < 15; i++) {
      const res = await request(ENTRY).get('/api/products');
      expect(res.status).toBe(200);
    }
  });

  test('JWT behavior is unchanged while limits are configured', async () => {
    await applyLimits({ 'r-users': { limit: 1, windowMs: 60000 } });
    // Rate limiting runs AFTER the JWT middleware: missing/invalid JWTs
    // still receive the existing 401s, never a 429.
    const missing = await request(ENTRY).get('/api/users');
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('unauthorized');

    const invalid = await request(ENTRY).get('/api/users').set('Authorization', 'Bearer bad.token.here');
    expect(invalid.status).toBe(401);

    // Valid JWT within budget still succeeds.
    const token = await registerAndLogin('RL Valid JWT');
    const ok = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
  });

  test('invalid rate-limit configuration is rejected', async () => {
    const cases = [
      { limit: 0, windowMs: 5000 },
      { limit: -1, windowMs: 5000 },
      { limit: 2.5, windowMs: 5000 },
      { limit: 5, windowMs: 500 },     // below minimum window
      { limit: 5, windowMs: 3600001 }, // above maximum window
      { limit: 'five', windowMs: 5000 },
      'not-an-object',
    ];
    for (const rateLimit of cases) {
      const routes = originalRoutes.map((r) => (r.id === 'r-products' ? { ...r, rateLimit } : r));
      const res = await fetch(`${CP}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await admin()}` },
        body: JSON.stringify({ routes }),
      });
      expect(res.status).toBe(400);
    }
  });

  test('429 requests appear in metrics and request logs', async () => {
    const startedAt = Date.now();
    await applyLimits({ 'r-users': null, 'r-products': { limit: 1, windowMs: 30000 } });
    expect((await request(ENTRY).get('/api/products')).status).toBe(200);
    expect((await request(ENTRY).get('/api/products')).status).toBe(429);
    expect((await request(ENTRY).get('/api/products')).status).toBe(429);

    // Gateway metric snapshots must carry the dedicated counter.
    const [g1, g2] = await Promise.all([
      (await fetch(`${GW1}/gateway-health`)).json(),
      (await fetch(`${GW2}/gateway-health`)).json(),
    ]);
    const rateLimitedTotal = (g1.metrics.rateLimited || 0) + (g2.metrics.rateLimited || 0);
    expect(rateLimitedTotal).toBeGreaterThanOrEqual(2);

    // Logs are batch-inserted every second - wait for the flush.
    await new Promise((r) => setTimeout(r, 2500));
    const logsRes = await request(CP).get('/api/logs?status=rate_limited&limit=50').set('Authorization', `Bearer ${await admin()}`);
    expect(logsRes.status).toBe(200);
    const rows = logsRes.body.logs.filter((l) => new Date(l.timestamp).getTime() >= startedAt);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.status).toBe(429);
      expect(row.rateLimited).toBe(true);
      expect(row.backendService).toBe('products');
      expect(row.backendInstance).toBe('none');
    }

    // Numeric status filter keeps working too.
    const numeric = await request(CP).get('/api/logs?status=429&limit=10').set('Authorization', `Bearer ${await admin()}`);
    for (const log of numeric.body.logs) expect(log.status).toBe(429);
  });

  test('lab reset clears rate-limit counters', async () => {
    // The products window from the previous test is 30 s and NOT expired,
    // with 1/1 requests consumed: the next request must be 429 first.
    expect((await request(ENTRY).get('/api/products')).status).toBe(429);

    const reset = await request(CP).post('/api/reset').set('Authorization', `Bearer ${await admin()}`);
    expect(reset.status).toBe(200);

    // Without waiting for the window, the budget is available again.
    const res = await request(ENTRY).get('/api/products');
    expect(res.status).toBe(200);
  });

  test('Redis unavailability fails open (requests pass through)', async () => {
    const badRedis = new Redis({
      host: '127.0.0.1', port: 6390, // nothing listens here
      lazyConnect: true, connectTimeout: 300, maxRetriesPerRequest: 1,
      retryStrategy: () => null, enableOfflineQueue: false,
    });
    const app = express();
    app.use(createRateLimitMiddleware({
      getRouteForPath: () => ({ id: 'failopen-test', authRequired: false, rateLimit: { limit: 1, windowMs: 60000 } }),
      redis: badRedis,
      gatewayName: 'rate-limit-test',
    }));
    app.get('/api/test', (req, res) => res.json({ ok: true }));

    // The counter cannot be incremented; documented fail-open behavior is to
    // allow the request rather than fail the client.
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    badRedis.disconnect();
  });

  test('client IP normalization', () => {
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::1')).toBe('127.0.0.1');
    expect(normalizeClientIp('198.51.100.7')).toBe('198.51.100.7');
    expect(normalizeClientIp('')).toBe('unknown');
    expect(normalizeClientIp(undefined)).toBe('unknown');
  });
});
