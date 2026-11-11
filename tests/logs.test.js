/**
 * TEST 11: request logs are generated, persisted to MongoDB and queryable.
 */
const request = require('supertest');
const ENTRY = 'http://localhost:14100';
const CP = 'http://localhost:15000';

describe('Request logging', () => {
  test('TEST 11: processed requests appear in MongoDB-backed logs', async () => {
    const token = await (await fetch(`${CP}/api/demo-token?type=valid`)).json();

    // Generate a mix of real traffic.
    await request(ENTRY).get('/api/products');                          // 200 public
    await request(ENTRY).get('/api/users');                             // 401 missing
    await request(ENTRY).get('/api/users').set('Authorization', 'Bearer bad.token.here'); // 401 invalid
    await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token.token}`); // 200 valid

    // Logs are batch-inserted every second - wait for the flush.
    await new Promise((r) => setTimeout(r, 2500));

    const res = await request(CP).get('/api/logs?limit=50');
    expect(res.status).toBe(200);
    const logs = res.body.logs;
    expect(logs.length).toBeGreaterThanOrEqual(4);

    const find = (fn) => logs.find(fn);
    expect(find((l) => l.status === 401 && l.jwtStatus === 'missing')).toBeTruthy();
    expect(find((l) => l.status === 401 && l.jwtStatus === 'invalid')).toBeTruthy();
    const valid = find((l) => l.jwtStatus === 'valid' && l.status === 200);
    expect(valid).toBeTruthy();
    expect(valid.backendService).toBe('users');
    expect(valid.gateway).toMatch(/^gateway-/);
    expect(typeof valid.latencyMs).toBe('number');
  });

  test('search and status filters work', async () => {
    const res = await request(CP).get('/api/logs?status=unauthorized&limit=10');
    expect(res.status).toBe(200);
    for (const log of res.body.logs) expect(log.status).toBe(401);

    const searched = await request(CP).get('/api/logs?search=/api/users&limit=10');
    for (const log of searched.body.logs) expect(log.path).toContain('/api/users');
  });
});
