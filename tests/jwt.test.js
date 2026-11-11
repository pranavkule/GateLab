/**
 * TEST 1-4: JWT authentication behaviour through the entry load balancer.
 */
const request = require('supertest');
const ENTRY = 'http://localhost:14100';
const CP = 'http://localhost:15000';

async function validToken() {
  const res = await fetch(`${CP}/api/demo-token?type=valid`);
  return (await res.json()).token;
}

describe('JWT authentication', () => {
  test('TEST 1: public API works without JWT -> 200', async () => {
    const res = await request(ENTRY).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('service', 'products');
  });

  test('TEST 2: protected route without JWT -> 401 (missing)', async () => {
    const res = await request(ENTRY).get('/api/users');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Missing/i);
  });

  test('TEST 3: invalid JWT -> 401', async () => {
    const res = await request(ENTRY).get('/api/users').set('Authorization', 'Bearer this.is.not.a.valid.jwt');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid/i);
  });

  test('TEST 4: valid JWT -> 200 and request reaches User Service', async () => {
    const token = await validToken();
    const res = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('service', 'users');
    expect(res.body).toHaveProperty('timestamp');
  });

  test('expired JWT -> 401 with expiry message', async () => {
    const res = await fetch(`${CP}/api/demo-token?type=expired`);
    const { token } = await res.json();
    const r = await request(ENTRY).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/expired/i);
  });

  test('auth service login issues verifiable JWT', async () => {
    const login = await fetch('http://localhost:15001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    const verify = await fetch('http://localhost:15001/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const verdict = await verify.json();
    expect(verdict.valid).toBe(true);
    expect(verdict.payload.sub).toBe('admin');
  });
});
