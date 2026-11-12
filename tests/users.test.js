/**
 * P1.2 tests: User Service business logic.
 *
 * Covers registration, customer login, profile self-service (identity from
 * the gateway-verified auth context), role-escalation prevention and the
 * admin-only lookup - all through the REAL gateway chain
 * (entry LB -> gateway -> JWT middleware -> reverse proxy -> service).
 */
const request = require('supertest');
const ENTRY = 'http://localhost:14100';
const AUTH = 'http://localhost:15001';
const TEST_DB = 'mongodb://127.0.0.1:27018/edgegate_test';

const { connectDb, disconnectDb } = require('../backend/db');
const { UserProfile } = require('../backend/models');
const { hashPassword } = require('../backend/utils/password');

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ADMIN_EMAIL = 'lab-admin@example.com';
const ADMIN_PASSWORD = 'Admin@123';
const CUSTOMER_EMAIL = `customer-${runId}@example.com`;
const CUSTOMER_PASSWORD = 'Customer@123';

let adminToken = null;
let adminId = null;
let customerToken = null;

async function registerCustomer(overrides = {}) {
  const body = {
    name: `Test Customer ${runId}`,
    email: CUSTOMER_EMAIL,
    password: CUSTOMER_PASSWORD,
    phone: '+91 90000 12345',
    address: { line1: '1 Test Lane', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
    ...overrides,
  };
  const res = await fetch(`${AUTH}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function customerLogin(email, password) {
  const res = await fetch(`${AUTH}/auth/customer-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await connectDb(TEST_DB);
  // Admin identity for authorization tests. Registration always creates
  // customers (role is never client-controlled), so the admin profile is
  // provisioned directly; the admin TOKEN is still obtained through the
  // real customer-login endpoint.
  await UserProfile.updateOne(
    { email: ADMIN_EMAIL },
    { $setOnInsert: { name: 'Lab Admin', email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'admin' } },
    { upsert: true }
  );
  const login = await customerLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  adminToken = login.body.token;
  adminId = login.body.user.id;
}, 20000);

afterAll(async () => {
  await disconnectDb();
});

describe('Registration (POST /auth/register)', () => {
  test('successful registration creates a customer profile without exposing the hash', async () => {
    const { status, body } = await registerCustomer();
    expect(status).toBe(201);
    expect(body.user.email).toBe(CUSTOMER_EMAIL);
    expect(body.user.role).toBe('customer');
    expect(body.user.name).toContain(runId);
    expect(body.user.phone).toBe('+91 90000 12345');
    expect(body.user.address.city).toBe('Pune');
    expect(JSON.stringify(body)).not.toMatch(/passwordHash/i);
    expect(JSON.stringify(body)).not.toContain(CUSTOMER_PASSWORD);
  });

  test('email is normalized (trimmed + lowercased)', async () => {
    const { status, body } = await registerCustomer({ email: `Case.${runId}@EXAMPLE.com` });
    expect(status).toBe(201);
    expect(body.user.email).toBe(`case.${runId}@example.com`);
  });

  test('duplicate email rejected with 409', async () => {
    const { status, body } = await registerCustomer();
    expect(status).toBe(409);
    expect(body.message).toMatch(/already registered/i);
  });

  test('invalid registration data rejected with 400', async () => {
    expect((await registerCustomer({ name: '' })).status).toBe(400);
    expect((await registerCustomer({ name: 'ok name', email: 'not-an-email' })).status).toBe(400);
    expect((await registerCustomer({ name: 'ok name', password: 'short' })).status).toBe(400);
    expect((await registerCustomer({ name: 'ok name', phone: 12345 })).status).toBe(400);
    expect((await registerCustomer({ name: 'ok name', address: 'nope' })).status).toBe(400);
  });
});

describe('Customer login (POST /auth/customer-login)', () => {
  test('valid credentials return a verifiable token and user', async () => {
    const { status, body } = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(CUSTOMER_EMAIL);
    expect(body.user.role).toBe('customer');
    customerToken = body.token;

    const verify = await fetch(`${AUTH}/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: body.token }),
    });
    const verdict = await verify.json();
    expect(verdict.valid).toBe(true);
    expect(verdict.payload.role).toBe('customer');
  });

  test('wrong password rejected with 401', async () => {
    const { status, body } = await customerLogin(CUSTOMER_EMAIL, 'WrongPassword1');
    expect(status).toBe(401);
    expect(body.message).toMatch(/invalid/i);
  });

  test('unknown email rejected with 401 (same message as wrong password)', async () => {
    const wrong = await customerLogin(CUSTOMER_EMAIL, 'WrongPassword1');
    const unknown = await customerLogin(`nobody-${runId}@example.com`, 'Whatever@123');
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });
});

describe('Profile self-service through the gateway (/api/users/me)', () => {
  test('missing JWT -> gateway 401', async () => {
    const res = await request(ENTRY).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  test('GET /api/users/me returns the authenticated profile (no hash)', async () => {
    const res = await request(ENTRY).get('/api/users/me').set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(CUSTOMER_EMAIL);
    expect(res.body.user.role).toBe('customer');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  test('PUT /api/users/me updates profile fields (persisted in shared MongoDB)', async () => {
    const res = await request(ENTRY)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ name: `Updated ${runId}`, phone: '+91 91111 22222', address: { city: 'Mumbai', line1: '2 Updated Road' } });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe(`Updated ${runId}`);

    // Follow-up GET may be served by the OTHER instance -> shared MongoDB.
    const get = await request(ENTRY).get('/api/users/me').set('Authorization', `Bearer ${customerToken}`);
    expect(get.status).toBe(200);
    expect(get.body.user.name).toBe(`Updated ${runId}`);
    expect(get.body.user.phone).toBe('+91 91111 22222');
    expect(get.body.user.address.city).toBe('Mumbai');
  });

  test('customers cannot change their own role, email or credentials', async () => {
    const res = await request(ENTRY)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ role: 'admin', email: 'hacker@example.com', passwordHash: 'forged' });
    expect(res.status).toBe(200); // ignored fields are stripped, not fatal

    const get = await request(ENTRY).get('/api/users/me').set('Authorization', `Bearer ${customerToken}`);
    expect(get.body.user.role).toBe('customer');
    expect(get.body.user.email).toBe(CUSTOMER_EMAIL);
    expect(get.body.user.passwordHash).toBeUndefined();
  });

  test('identity comes from the verified context, not client-supplied ids', async () => {
    // A forged x-auth-user header sent to the GATEWAY is ignored: the gateway
    // overwrites it during JWT verification, so the profile returned still
    // belongs to the token subject.
    const forged = Buffer.from(JSON.stringify({ sub: adminId, role: 'admin' })).toString();
    const res = await request(ENTRY)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-auth-user', forged);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(CUSTOMER_EMAIL); // NOT the admin profile
  });
});

describe('Admin user lookup (GET /api/users/:id)', () => {
  test('customers get 403 (admin role required)', async () => {
    const res = await request(ENTRY).get(`/api/users/${adminId}`).set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin/i);
  });

  test('admin can retrieve a user by id (no hash exposed)', async () => {
    const me = await request(ENTRY).get('/api/users/me').set('Authorization', `Bearer ${customerToken}`);
    const customerId = me.body.user._id;
    const res = await request(ENTRY).get(`/api/users/${customerId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(CUSTOMER_EMAIL);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  test('unknown id -> 404 for admins', async () => {
    const res = await request(ENTRY)
      .get('/api/users/aaaaaaaaaaaaaaaaaaaaaaaa')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('malformed id -> 404 (no 500)', async () => {
    const res = await request(ENTRY).get('/api/users/not-an-objectid').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
