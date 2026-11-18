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

  test('student lab login issues verifiable JWT', async () => {
    const login = await fetch('http://localhost:15001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'edgegate-test-student', password: 'test-only-student-password' }),
    });
    expect(login.status).toBe(200);
    const { token, user } = await login.json();
    expect(user.role).toBe('student');
    const verify = await fetch('http://localhost:15001/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const verdict = await verify.json();
    expect(verdict.valid).toBe(true);
    expect(verdict.payload.sub).toBe('edgegate-test-student');
    expect(verdict.payload.role).toBe('student');
  });

  test('student lab login rejects invalid credentials', async () => {
    const login = await fetch('http://localhost:15001/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'edgegate-test-student', password: 'incorrect-password' }),
    });
    expect(login.status).toBe(401);
    const body = await login.json();
    expect(body.message).toBe('Invalid username or password');
  });

  test('unknown and incorrect student credentials use the same authentication response', async () => {
    const attempts = await Promise.all(['missing-student', 'edgegate-test-student'].map((username) => (
      fetch('http://localhost:15001/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'incorrect-password' }),
      })
    )));
    const results = await Promise.all(attempts.map(async (response) => ({
      status: response.status,
      body: await response.json(),
    })));
    expect(results).toEqual([
      { status: 401, body: { error: 'unauthorized', message: 'Invalid username or password' } },
      { status: 401, body: { error: 'unauthorized', message: 'Invalid username or password' } },
    ]);
  });

  test('customer and admin UserProfiles remain outside student lab login', async () => {
    const adminLogin = await fetch('http://localhost:15001/auth/customer-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'lab-admin@example.test', password: 'TestAdminPassword123' }),
    });
    expect(adminLogin.status).toBe(200);
    const admin = await adminLogin.json();
    expect(admin.user.role).toBe('admin');

    const labAttempt = await fetch('http://localhost:15001/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lab-admin@example.test', password: 'TestAdminPassword123' }),
    });
    expect(labAttempt.status).toBe(401);

    const email = `lab-customer-${Date.now()}@example.test`;
    const registration = await fetch('http://localhost:15001/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lab Customer', email, password: 'TestCustomerPassword123' }),
    });
    expect(registration.status).toBe(201);
    const customerLogin = await fetch('http://localhost:15001/auth/customer-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestCustomerPassword123' }),
    });
    expect(customerLogin.status).toBe(200);
    const customer = await customerLogin.json();
    expect(customer.user.role).toBe('customer');

    const customerLabAttempt = await fetch('http://localhost:15001/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password: 'TestCustomerPassword123' }),
    });
    expect(customerLabAttempt.status).toBe(401);
  });
});
