/**
 * TEST 5-10: dynamic routing, synchronization, load balancing,
 * failure handling and recovery.
 */
const request = require('supertest');
const ENTRY = 'http://localhost:14100';
const CP = 'http://localhost:15000';

async function latestConfig() {
  const res = await fetch(`${CP}/api/config/latest`);
  return res.json();
}
async function applyRoutes(routes) {
  const res = await fetch(`${CP}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes }),
  });
  if (!res.ok) throw new Error(`apply failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function validToken() {
  const res = await fetch(`${CP}/api/demo-token?type=valid`);
  return (await res.json()).token;
}

afterAll(async () => {
  // Restore the original configuration so later suites are unaffected.
  const cfg = await latestConfig();
  const restored = cfg.routes.map((r) => r.id === 'r-products' ? { ...r, targetService: 'products' } : r);
  await applyRoutes(restored);
});

describe('Dynamic routing', () => {
  test('TEST 5: changing a route target takes effect without restart', async () => {
    const before = await request(ENTRY).get('/api/products');
    expect(before.headers['x-service']).toBe('products');

    const cfg = await latestConfig();
    const changed = cfg.routes.map((r) => r.id === 'r-products' ? { ...r, targetService: 'orders' } : r);
    const applied = await applyRoutes(changed);
    expect(applied.version).toBeGreaterThan(cfg.version);

    // New requests must hit the NEW target (gateways reload live).
    const after = await request(ENTRY).get('/api/products');
    expect(after.status).toBe(200);
    expect(after.headers['x-service']).toBe('orders');
  });

  test('TEST 6: all gateway instances converge on the same config version', async () => {
    const cfg = await latestConfig();
    const g1 = await (await fetch('http://localhost:14101/gateway-health')).json();
    const g2 = await (await fetch('http://localhost:14102/gateway-health')).json();
    expect(g1.configVersion).toBe(cfg.version);
    expect(g2.configVersion).toBe(cfg.version);
  });

  test('invalid configuration is rejected with a validation error', async () => {
    const res = await fetch(`${CP}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes: [{ id: 'x', path: 'nope', targetService: 'nope', authRequired: false }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Load balancing', () => {
  test('TEST 7: 20 requests spread across two healthy instances', async () => {
    const token = await validToken();
    const counts = {};
    for (let i = 0; i < 20; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      counts[res.headers['x-instance']] = (counts[res.headers['x-instance']] || 0) + 1;
    }
    expect(Object.keys(counts).sort()).toEqual(['14001', '14002']);
    expect(counts['14001']).toBeGreaterThanOrEqual(8);
    expect(counts['14002']).toBeGreaterThanOrEqual(8);
  });
});

describe('Failure simulation and recovery', () => {
  test('TEST 8: failed backend instance receives no new traffic', async () => {
    await fetch(`${CP}/api/backend/14001/fail`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 300));
    const token = await validToken();
    for (let i = 0; i < 10; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['x-instance']).toBe('14002');
    }
  });

  test('TEST 9: failed gateway instance receives no new traffic', async () => {
    await fetch(`${CP}/api/gateway/14102/fail`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 10; i++) {
      const res = await request(ENTRY).get('/api/products');
      expect(res.status).toBe(200);
      expect(res.headers['x-gateway']).toBe('gateway-14101');
    }
  });

  test('TEST 10: recovered instances rejoin the round-robin', async () => {
    await fetch(`${CP}/api/gateway/14102/recover`, { method: 'POST' });
    await fetch(`${CP}/api/backend/14001/recover`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1600)); // let active health checks confirm

    const h1 = await (await fetch('http://localhost:14102/gateway-health')).json();
    expect(h1.status).toBe('up');

    const token = await validToken();
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
      seen.add(res.headers['x-instance']);
    }
    expect(seen.has('14001')).toBe(true);
    expect(seen.has('14002')).toBe(true);
  });

  test('all backend instances down -> 503 Service Unavailable', async () => {
    await fetch(`${CP}/api/backend/14001/fail`, { method: 'POST' });
    await fetch(`${CP}/api/backend/14002/fail`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 300));
    const token = await validToken();
    const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    await fetch(`${CP}/api/backend/14001/recover`, { method: 'POST' });
    await fetch(`${CP}/api/backend/14002/recover`, { method: 'POST' });
  });
});
