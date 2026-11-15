/**
 * TEST SUITE (P2.5.2): Circuit-breaker dashboard observability + Virtual Lab
 * scenario building blocks.
 *
 * Runs against the real miniature stack (tests/stackRunner.js):
 *   entry LB :14100 -> gateways :14101/:14102 -> backends,
 *   control plane :15000, auth :15001, Redis :6381, MongoDB edgegate_test.
 * Stack circuit settings: CB_FAILURE_THRESHOLD=5, CB_COOLDOWN_MS=2000,
 * CB_HALF_OPEN_PROBES=2.
 *
 * Unlike tests/circuitBreaker.test.js (state-machine semantics), this suite
 * verifies the SURFACE the P2.5.2 dashboard consumes:
 *   - /gateway-health exposes a circuits map for every configured instance;
 *   - the 1 s gateway METRICS snapshots (Redis channel -> control plane ->
 *     Socket.IO "metrics" event) carry the same shared circuit states;
 *   - blocked requests produce 503 circuit_open + Retry-After +
 *     x-edgegate-circuit through the ENTRY load balancer;
 *   - HALF-OPEN is visible to monitoring before any probe happens;
 *   - manual Recover clears the state on the observability surface.
 *
 * No backend circuit-breaker logic is modified: every state transition here
 * is driven by REAL traffic against the existing P2.5.1 stack.
 *
 * Cleanup: original routes restored, backends recovered, only the circuit
 * namespace (edgegate:cb:*) is flushed.
 */
const request = require('supertest');
const Redis = require('ioredis');
const { CB_KEY_PREFIX, clearCircuitKeys } = require('../backend/circuitBreaker');
const { CHANNELS } = require('../backend/redis');
const { getTestRedisUrl } = require('./testTargetSafety');

const ENTRY = 'http://localhost:14100';
const GW1 = 'http://127.0.0.1:14101';
const CP = 'http://localhost:15000';
const TEST_REDIS = getTestRedisUrl();

const PRODUCTS = 14003; // single products instance
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

async function gatewayHealth(base = GW1) {
  const res = await fetch(`${base}/gateway-health`);
  return res.json();
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

describe('Circuit breaker dashboard + Virtual Lab (P2.5.2)', () => {
  test('setup: clean circuits, no rate limits, capture original configuration', async () => {
    const cfg = await latestConfig();
    originalRoutes = cfg.routes.map((r) => ({ ...r }));
    await applyRoutes(originalRoutes.map((r) => ({ ...r, rateLimit: null })));
    for (const port of ALL_BACKENDS) {
      try { await backendCmd(port, 'recover'); } catch (_) {}
      await redis.del(`${CB_KEY_PREFIX}${port}`);
    }
  });

  test('OBS 1: /gateway-health exposes a circuits map for every configured backend instance', async () => {
    const health = await gatewayHealth();
    expect(health.status).toBe('up');
    expect(typeof health.circuits).toBe('object');
    for (const port of ALL_BACKENDS) {
      const c = health.circuits[String(port)];
      expect(c).toBeDefined();
      expect(c.port).toBe(port);
      expect(c.state).toBe('closed');
      expect(c.storedState).toBe('closed');
      expect(c.failures).toBe(0);
      expect(c.probes).toBe(0);
      expect(c.retryAfterMs).toBe(0);
    }
  });

  test('OBS 2: real failures flip the reported state to OPEN on the REST surface', async () => {
    await backendCmd(PRODUCTS, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await request(GW1).get('/api/products');
      expect(res.status).toBe(500);
    }
    const c = (await gatewayHealth()).circuits[String(PRODUCTS)];
    expect(c.state).toBe('open');
    expect(c.failures).toBeGreaterThanOrEqual(5);
    expect(c.retryAfterMs).toBeGreaterThan(0);
    expect(c.retryAfterMs).toBeLessThanOrEqual(2000); // stack cooldown is 2 s
  });

  test('OBS 3: the 1 s gateway METRICS snapshots (Socket.IO source) carry the same shared circuit states', async () => {
    // Refresh the OPEN state right before observing so early snapshots land
    // inside the 2 s cooldown window.
    await backendCmd(PRODUCTS, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) await request(GW1).get('/api/products');
    const sub = new Redis(TEST_REDIS);
    await sub.subscribe(CHANNELS.METRICS);
    const snapshots = [];
    sub.on('message', (channel, message) => {
      try { snapshots.push(JSON.parse(message)); } catch (_) { /* ignore */ }
    });
    await wait(1500); // inside the 2 s cooldown
    const gatewaySnaps = snapshots.filter((s) => s.kind === 'gateway' && s.circuits);
    expect(gatewaySnaps.length).toBeGreaterThan(0);
    // Every gateway publishes the SAME shared Redis state: the products
    // circuit is visible as OPEN (cooldown not yet expired).
    const openSnaps = gatewaySnaps.filter((s) => s.circuits[String(PRODUCTS)].state === 'open');
    expect(openSnaps.length).toBeGreaterThan(0);
    // Manual Recover must clear the state on this surface too.
    const recoverTs = Date.now();
    await backendCmd(PRODUCTS, 'recover');
    await wait(2500);
    const after = snapshots.filter((s) => s.kind === 'gateway' && s.circuits && s.ts > recoverTs);
    expect(after.length).toBeGreaterThan(0);
    for (const snap of after) {
      expect(snap.circuits[String(PRODUCTS)].state).toBe('closed');
      expect(snap.circuits[String(PRODUCTS)].failures).toBe(0);
    }
    await sub.quit();
  });

  test('OBS 4: HALF-OPEN is visible to monitoring while stored state remains OPEN', async () => {
    // Re-open the products circuit with real traffic.
    await backendCmd(PRODUCTS, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) await request(GW1).get('/api/products');
    expect((await gatewayHealth()).circuits[String(PRODUCTS)].state).toBe('open');
    await wait(2400); // cooldown 2 s expires - the lazy transition is only
    // performed by admit(); monitoring reports the effective HALF-OPEN state
    // while the stored state stays OPEN (health checks never touch the CB).
    const c = (await gatewayHealth()).circuits[String(PRODUCTS)];
    expect(c.state).toBe('half-open');
    expect(c.storedState).toBe('open');
    await backendCmd(PRODUCTS, 'recover'); // reset for the next test
  });

  test('OBS 5: Virtual Lab blocked-requests phase - 503 circuit_open with headers relayed through the ENTRY LB', async () => {
    // Open BOTH users circuits with real traffic: hard-down the sibling,
    // park 5 failures on :14001, then swap so :14002 takes the failures too.
    await backendCmd(USERS_B, 'fail');
    await wait(300);
    await backendCmd(USERS_A, 'errors', { rate: 1 });
    const token = await admin();
    for (let i = 0; i < 5; i++) {
      const res = await request(GW1).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(500);
    }
    expect((await gatewayHealth()).circuits[String(USERS_A)].state).toBe('open');
    // Bring the sibling back (recover resets its circuit) and fail IT instead:
    // every request now reaches :14002, whose circuit opens as well.
    await backendCmd(USERS_B, 'recover');
    await wait(300);
    await backendCmd(USERS_B, 'errors', { rate: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await request(GW1).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(500);
    }
    expect((await gatewayHealth()).circuits[String(USERS_B)].state).toBe('open');
    // Blocked phase: every available instance is circuit-blocked. Through the
    // ENTRY load balancer the 503 must stay circuit_open with Retry-After and
    // the relayed x-edgegate-circuit marker - exactly what the Lab scenario
    // and the dashboard observe.
    for (let i = 0; i < 4; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('circuit_open');
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(res.headers['x-edgegate-circuit']).toBe('open');
      expect(res.body.retryAfterMs).toBeGreaterThan(0);
    }
    // Recovery: clear the error injection and Recover both instances - the
    // circuits reset immediately (no cooldown wait) and traffic resumes.
    await backendCmd(USERS_A, 'errors', { rate: 0 });
    await backendCmd(USERS_B, 'errors', { rate: 0 });
    await backendCmd(USERS_A, 'recover');
    await backendCmd(USERS_B, 'recover');
    await wait(300);
    for (let i = 0; i < 3; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
    expect((await gatewayHealth()).circuits[String(USERS_A)].state).toBe('closed');
    expect((await gatewayHealth()).circuits[String(USERS_B)].state).toBe('closed');
  });
});
