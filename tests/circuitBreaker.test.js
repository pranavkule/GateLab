/**
 * TEST SUITE (P2.5.1): Redis-backed circuit breaker core.
 *
 * Runs against the real miniature stack (tests/stackRunner.js):
 *   entry LB :14100 -> gateways :14101/:14102 -> backends,
 *   control plane :15000, auth :15001, Redis :6381, MongoDB edgegate_test.
 *
 * Stack circuit settings (stackRunner.js): CB_FAILURE_THRESHOLD=5,
 * CB_COOLDOWN_MS=2000, CB_HALF_OPEN_PROBES=2.
 *
 * The products route (/api/products) targets the SINGLE instance :14003,
 * which makes per-instance circuit behavior directly observable; the users
 * route has two instances (:14001/:14002) for the healthy-sibling test.
 *
 * Circuit state is shared Redis state (edgegate:cb:<port>) - every
 * assertion reads it back through a gateway's /gateway-health endpoint.
 *
 * Cleanup: original routes are restored, all backends are recovered and
 * ONLY the circuit-breaker / rate-limit namespaces are flushed.
 */
const request = require('supertest');
const Redis = require('ioredis');
const {
  CB_KEY_PREFIX,
  loadCircuitConfig,
  createCircuitBreaker,
  clearCircuitKeys,
} = require('../backend/circuitBreaker');
const { getTestRedisUrl } = require('./testTargetSafety');

const ENTRY = 'http://localhost:14100';
const GW1 = 'http://127.0.0.1:14101';
const GW2 = 'http://127.0.0.1:14102';
const CP = 'http://localhost:15000';
const TEST_REDIS = getTestRedisUrl();

const CB_PORT = 14003;         // single products instance
const USERS_A = 14001;
const USERS_B = 14002;
const ALL_BACKENDS = [14001, 14002, 14003, 14004];

const redis = new Redis(TEST_REDIS);
let adminToken = null;
let originalRoutes = null;

async function admin() {
  if (adminToken) return adminToken;
  const res = await fetch(`${CP}/api/demo-token?type=valid`);
  adminToken = (await res.json()).token;
  return adminToken;
}

async function backendCmd(port, action, value) {
  const res = await fetch(`${CP}/api/backend/${port}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await admin()}` },
    body: value !== undefined ? JSON.stringify(value) : undefined,
  });
  if (!res.ok) throw new Error(`backend ${port} ${action} failed: ${res.status}`);
}

async function latestConfig() {
  const res = await fetch(`${CP}/api/config/latest`);
  return res.json();
}

async function applyRoutes(routes) {
  const res = await fetch(`${CP}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await admin()}` },
    body: JSON.stringify({ routes }),
  });
  if (!res.ok) throw new Error(`apply failed: ${res.status} ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 400)); // let Pub/Sub reach both gateways
}

async function circuitStatus(port, base = GW1) {
  const res = await fetch(`${base}/gateway-health`);
  const body = await res.json();
  return body.circuits[String(port)];
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

afterAll(async () => {
  try { if (originalRoutes) await applyRoutes(originalRoutes); } catch (_) {}
  for (const port of ALL_BACKENDS) { try { await backendCmd(port, 'recover'); } catch (_) {} }
  try { await clearCircuitKeys(redis); } catch (_) {}
  try { await redis.quit(); } catch (_) {}
});

describe('Circuit breaker (P2.5.1)', () => {
  test('setup: capture original configuration and start with clean circuits', async () => {
    const cfg = await latestConfig();
    originalRoutes = cfg.routes.map((r) => ({ ...r }));
    // Remove any rate limits so 429s cannot interfere with classification.
    await applyRoutes(originalRoutes.map((r) => ({ ...r, rateLimit: null })));
    for (const port of ALL_BACKENDS) {
      try { await backendCmd(port, 'recover'); } catch (_) {}
      await redis.del(`${CB_KEY_PREFIX}${port}`);
    }
  });

  test('configuration: defaults, validation and safe fallbacks', () => {
    expect(loadCircuitConfig({})).toEqual({
      failureThreshold: 5, cooldownMs: 10000, halfOpenProbes: 1,
      safetyTtlMs: Math.max(10000 * 4, 60000),
    });
    expect(loadCircuitConfig({ CB_FAILURE_THRESHOLD: '3', CB_COOLDOWN_MS: '5000', CB_HALF_OPEN_PROBES: '2' }))
      .toMatchObject({ failureThreshold: 3, cooldownMs: 5000, halfOpenProbes: 2 });
    // Invalid values fall back to safe defaults (never 0/negative/NaN).
    expect(loadCircuitConfig({ CB_FAILURE_THRESHOLD: '0' })).toMatchObject({ failureThreshold: 5 });
    expect(loadCircuitConfig({ CB_FAILURE_THRESHOLD: '-2' })).toMatchObject({ failureThreshold: 5 });
    expect(loadCircuitConfig({ CB_FAILURE_THRESHOLD: 'x' })).toMatchObject({ failureThreshold: 5 });
    expect(loadCircuitConfig({ CB_COOLDOWN_MS: '50' })).toMatchObject({ cooldownMs: 10000 });
    expect(loadCircuitConfig({ CB_COOLDOWN_MS: 'abc' })).toMatchObject({ cooldownMs: 10000 });
    expect(loadCircuitConfig({ CB_HALF_OPEN_PROBES: '0' })).toMatchObject({ halfOpenProbes: 1 });
  });

  test('TEST 1: CLOSED permits normal requests', async () => {
    await backendCmd(CB_PORT, 'recover');
    const res = await request(GW1).get('/api/products');
    expect(res.status).toBe(200);
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('closed');
    expect(cb.failures).toBe(0);
  });

  test('TEST 2: reaching the failure threshold (upstream 5xx) opens the circuit', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await request(GW1).get('/api/products');
      expect(res.status).toBe(500); // the upstream 5xx itself is passed through
    }
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('open');
    expect(cb.failures).toBeGreaterThanOrEqual(5);
  });

  test('TEST 3: OPEN blocks requests before the cooldown with Retry-After', async () => {
    const res = await request(GW1).get('/api/products');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('circuit_open');
    expect(res.headers['retry-after']).toBeDefined();
    const retrySeconds = Number(res.headers['retry-after']);
    expect(retrySeconds).toBeGreaterThanOrEqual(1);
    expect(retrySeconds).toBeLessThanOrEqual(2); // cooldown is 2 s
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    expect(res.body.retryAfterMs).toBeLessThanOrEqual(2000);
  });

  test('TEST 4: after the cooldown the circuit transitions to HALF-OPEN and admits a probe', async () => {
    await wait(2400); // cooldown 2000 ms
    const res = await request(GW1).get('/api/products');
    // The probe must REACH the backend (still injecting 100% errors -> 500),
    // proving it was admitted instead of being blocked with circuit_open.
    expect(res.status).toBe(500);
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('open'); // failed probe reopened the circuit
  });

  test('TEST 7: a failed HALF-OPEN probe reopens the circuit (fresh cooldown)', async () => {
    // Circuit was reopened by the failed probe in TEST 4: while the new
    // cooldown runs, requests are blocked again.
    const res = await request(GW1).get('/api/products');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('circuit_open');
  });

  test('TEST 5 + TEST 8: concurrent requests across BOTH gateways respect the shared HALF-OPEN probe limit', async () => {
    await wait(2400); // cooldown from TEST 7's reopen expires -> HALF-OPEN
    // 8 concurrent requests split across the two gateway processes; Redis
    // state is shared, so at most CB_HALF_OPEN_PROBES=2 may reach :14003.
    const targets = [GW1, GW2, GW1, GW2, GW1, GW2, GW1, GW2];
    const responses = await Promise.all(targets.map((base) => fetch(`${base}/api/products`)));
    const statuses = [];
    for (const res of responses) {
      const body = await res.json();
      statuses.push({ status: res.status, error: body.error });
    }
    const upstreamHits = statuses.filter((s) => s.status === 500).length;
    const blocked = statuses.filter((s) => s.status === 503 && s.error === 'circuit_open').length;
    expect(upstreamHits).toBeGreaterThanOrEqual(1);
    expect(upstreamHits).toBeLessThanOrEqual(2);      // exactly the probe budget
    expect(blocked).toBeGreaterThanOrEqual(6);
    expect(upstreamHits + blocked).toBe(8);           // nothing else leaked through
  });

  test('TEST 6: a successful HALF-OPEN probe closes the circuit', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 0 }); // backend healthy again
    await wait(2400); // cooldown from the TEST 8 reopen expires -> HALF-OPEN
    const res = await request(GW1).get('/api/products');
    expect(res.status).toBe(200);
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('closed');
    expect(cb.failures).toBe(0);
    // Normal traffic continues afterwards.
    expect((await request(GW1).get('/api/products')).status).toBe(200);
  });

  test('TEST 14: upstream 5xx responses increment the failure counter (below threshold stays CLOSED)', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 1 });
    for (let i = 0; i < 3; i++) {
      const res = await request(GW1).get('/api/products');
      expect(res.status).toBe(500);
    }
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('closed'); // threshold is 5, only 3 consecutive
    expect(cb.failures).toBe(3);
  });

  test('TEST 13: upstream 4xx responses are successes and do NOT increment failures', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 0 });
    const res = await request(GW1).get('/api/products/does-not-exist-id');
    expect(res.status).toBe(404); // upstream 4xx, passed through
    const cb = await circuitStatus(CB_PORT);
    expect(cb.failures).toBe(0);
    expect(cb.state).toBe('closed');
  });

  test('TEST 15: gateway-generated 429 rate-limited responses never increment failures', async () => {
    // Give the products route a strict shared limit (fresh config version).
    const cfg = await latestConfig();
    await applyRoutes(cfg.routes.map((r) => (r.id === 'r-products' ? { ...r, rateLimit: { limit: 1, windowMs: 60000 } } : r)));
    expect((await request(GW1).get('/api/products')).status).toBe(200);
    expect((await request(GW1).get('/api/products')).status).toBe(429);
    expect((await request(GW1).get('/api/products')).status).toBe(429);
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('closed');
    expect(cb.failures).toBe(0);
    // Back to unlimited for the remaining tests.
    await applyRoutes(cfg.routes.map((r) => ({ ...r, rateLimit: null })));
  });

  test('TEST 10: manual Recover restores the backend and resets its circuit', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) await request(GW1).get('/api/products'); // 5 x 500 -> OPEN
    expect((await circuitStatus(CB_PORT)).state).toBe('open');
    await backendCmd(CB_PORT, 'recover'); // hard-down cleared AND circuit reset
    const res = await request(GW1).get('/api/products'); // no cooldown wait!
    expect(res.status).toBe(200);
    const cb = await circuitStatus(CB_PORT);
    expect(cb.state).toBe('closed');
    expect(cb.failures).toBe(0);
  });

  test('TEST 11: successful active health checks do NOT auto-close an OPEN circuit', async () => {
    await backendCmd(CB_PORT, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) await request(GW1).get('/api/products'); // -> OPEN
    expect((await circuitStatus(CB_PORT)).state).toBe('open');
    // The control-plane active checker polls /health every 1 s; /health of a
    // 100%-errors instance still reports UP (health ignores the simulation),
    // and it must NOT close the breaker. Wait for several check cycles.
    await wait(3500);
    const cb = await circuitStatus(CB_PORT);
    // The stored state must STILL be open (health checks never touch the
    // breaker); after the 2 s cooldown it is only reported as HALF-OPEN,
    // i.e. pending a real probe - never CLOSED by a health check.
    expect(cb.storedState).toBe('open');
    expect(cb.state).toBe('half-open');
    expect(cb.state).not.toBe('closed');
    await backendCmd(CB_PORT, 'recover');
  });

  test('TEST 9: one circuit-open backend does not block its healthy sibling', async () => {
    // users has two instances: :14001 and :14002
    await redis.del(`${CB_KEY_PREFIX}${USERS_A}`, `${CB_KEY_PREFIX}${USERS_B}`);
    await backendCmd(USERS_A, 'recover');
    await backendCmd(USERS_B, 'recover');
    await wait(300);
    // Park :14002 (administrative hard-down) so every request hits :14001...
    await backendCmd(USERS_B, 'fail');
    await wait(300);
    await backendCmd(USERS_A, 'errors', { rate: 1 });
    const token = (await (await fetch(`${CP}/api/demo-token?type=valid`)).json()).token;
    for (let i = 0; i < 5; i++) {
      const res = await request(GW1).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(500);
    }
    const cbA = await circuitStatus(USERS_A);
    expect(cbA.state).toBe('open'); // :14001 circuit OPEN in shared Redis
    // ...then stop the error injection and bring the sibling back.
    await backendCmd(USERS_A, 'errors', { rate: 0 });
    await backendCmd(USERS_B, 'recover'); // clears hard-down AND resets :14002's circuit
    await wait(300);
    // Every request must be served by the healthy sibling, never 502/503.
    for (let i = 0; i < 6; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['x-instance']).toBe(String(USERS_B));
    }
    // Recovering :14001 also resets its circuit -> it rejoins round-robin.
    await backendCmd(USERS_A, 'recover');
    await wait(300);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      seen.add(res.headers['x-instance']);
    }
    expect(seen.has(String(USERS_A))).toBe(true);
    expect(seen.has(String(USERS_B))).toBe(true);
  });

  test('TEST 16: a circuit-generated 503 does NOT degrade Entry LB gateway health', async () => {
    // Start from a clean circuit so the burst deterministically produces
    // 5 upstream 5xx responses (no leftover HALF-OPEN probe from TEST 11).
    await backendCmd(CB_PORT, 'errors', { rate: 1 });
    await redis.del(`${CB_KEY_PREFIX}${CB_PORT}`);
    for (let i = 0; i < 5; i++) {
      const res = await request(ENTRY).get('/api/products');
      expect(res.status).toBe(500); // 5 x upstream 5xx -> OPEN (shared state)
    }
    // Entry LB round-robins across both gateways; each 503 must be
    // circuit_open, and NEITHER gateway may be marked unhealthy.
    for (let i = 0; i < 6; i++) {
      const res = await request(ENTRY).get('/api/products');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('circuit_open');
    }
    const [g1, g2] = await Promise.all([
      (await fetch(`${GW1}/gateway-health`)).json(),
      (await fetch(`${GW2}/gateway-health`)).json(),
    ]);
    expect(g1.status).toBe('up');
    expect(g2.status).toBe('up');
    // If the Entry LB HAD marked the gateways unhealthy, this would answer
    // 503 "No healthy gateway instances available" instead of proxying.
    await backendCmd(CB_PORT, 'recover');
    const after = await request(ENTRY).get('/api/products');
    expect(after.status).toBe(200);
  });

  test('TEST 12: Redis unavailability follows the fail-open policy', async () => {
    const deadRedis = new Redis({
      host: '127.0.0.1', port: 6390, // nothing listens here
      lazyConnect: true, connectTimeout: 300, maxRetriesPerRequest: 1,
      retryStrategy: () => null, enableOfflineQueue: false,
    });
    const cb = createCircuitBreaker({ redis: deadRedis, name: 'cb-failopen-test' });
    // Reads fail open: everything is eligible, no blocking decision possible.
    expect((await cb.peekEligible(1234)).eligible).toBe(true);
    const filter = await cb.filterEligible([1234, 5678]);
    expect(filter.eligible).toEqual([1234, 5678]);
    expect(filter.blocked).toEqual([]);
    expect((await cb.admit(1234)).allowed).toBe(true);
    // Writes fail silent: the gateway must never crash on a Redis error.
    await expect(cb.recordFailure(1234)).resolves.toBeDefined();
    await expect(cb.recordSuccess(1234)).resolves.toBeDefined();
    expect((await cb.status(1234)).state).toBe('closed');
    await expect(cb.reset(1234)).resolves.toBe(false); // attempted, reported honestly
    deadRedis.disconnect();
  });
});
