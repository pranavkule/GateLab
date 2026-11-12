/**
 * P1.3 tests: Product Service business logic.
 *
 * Covers creation, validation, duplicate handling, browsing (filters,
 * search, pagination), detail retrieval, updates, soft deletion,
 * admin-only authorization and error hygiene - all through the REAL
 * gateway chain (entry LB -> gateway -> reverse proxy -> service).
 */
const request = require('supertest');
const ENTRY = 'http://localhost:14100';
const AUTH = 'http://localhost:15001';
const TEST_DB = 'mongodb://127.0.0.1:27018/edgegate_test';

const { connectDb, disconnectDb } = require('../backend/db');
const { UserProfile, Product } = require('../backend/models');
const { hashPassword } = require('../backend/utils/password');

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ADMIN_EMAIL = 'lab-admin@example.com';
const ADMIN_PASSWORD = 'Admin@123';
const CATEGORY = `Cat-${runId}`;

let adminToken = null;
let customerToken = null;

function productBody(overrides = {}) {
  return {
    name: `Product ${runId} ${Math.random().toString(36).slice(2, 6)}`,
    description: 'A test product',
    price: 999,
    category: CATEGORY,
    stock: 10,
    ...overrides,
  };
}

async function adminCreate(body) {
  return request(ENTRY).post('/api/products').set('Authorization', `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  await connectDb(TEST_DB);
  // Admin identity (shared with users.test.js; upsert is idempotent).
  await UserProfile.updateOne(
    { email: ADMIN_EMAIL },
    { $setOnInsert: { name: 'Lab Admin', email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'admin' } },
    { upsert: true }
  );
  adminToken = (await (await fetch(`${AUTH}/auth/customer-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })).json()).token;

  // A customer for authorization-restriction tests.
  const email = `p-customer-${runId}@example.com`;
  await fetch(`${AUTH}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Product Tester ${runId}`, email, password: 'Customer@123' }),
  });
  customerToken = (await (await fetch(`${AUTH}/auth/customer-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Customer@123' }),
  })).json()).token;
}, 20000);

afterAll(async () => {
  await disconnectDb();
});

describe('Admin product creation (POST /api/products)', () => {
  test('admin can create a product (201, persisted shape)', async () => {
    const res = await adminCreate(productBody({ name: `Created ${runId}` }));
    expect(res.status).toBe(201);
    expect(res.body.product.name).toBe(`Created ${runId}`);
    expect(res.body.product.status).toBe('active');
    expect(res.body.product.stock).toBe(10);
    expect(res.body.product.price).toBe(999);
    expect(res.body.product.createdAt).toBeTruthy();
    expect(res.body.service).toBe('products');
    expect(String(res.body.instance)).toMatch(/^\d+$/);
  });

  test('missing or invalid fields rejected with 400', async () => {
    expect((await adminCreate(productBody({ name: '' }))).status).toBe(400);
    expect((await adminCreate(productBody({ price: -1 }))).status).toBe(400);
    expect((await adminCreate(productBody({ price: 'free' }))).status).toBe(400);
    expect((await adminCreate(productBody({ stock: 2.5 }))).status).toBe(400);
    expect((await adminCreate(productBody({ stock: -5 }))).status).toBe(400);
    expect((await adminCreate(productBody({ category: '' }))).status).toBe(400);
    expect((await adminCreate(productBody({ status: 'bogus' }))).status).toBe(400);
  });

  test('duplicate product name rejected with 409 (no internals leaked)', async () => {
    const name = `Dup ${runId}`;
    expect((await adminCreate(productBody({ name }))).status).toBe(201);
    const dup = await adminCreate(productBody({ name }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already exists/i);
    expect(JSON.stringify(dup.body)).not.toMatch(/E11000|MongoError|MongoServerError|duplicate key/i);
  });

  test('creation requires admin: 401 without token, 403 for customers', async () => {
    expect((await request(ENTRY).post('/api/products').send(productBody())).status).toBe(401);
    const customer = await request(ENTRY).post('/api/products')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(productBody({ role: 'admin' })); // body role must never matter
    expect(customer.status).toBe(403);
  });
});

describe('Product browsing (public)', () => {
  test('GET /api/products returns active products (legacy contract preserved)', async () => {
    const res = await request(ENTRY).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('products'); // jwt.test.js TEST 1 contract
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    for (const p of res.body.products) expect(p.status).toBe('active');
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.pages).toBe('number');
  });

  test('category filter returns only matching products', async () => {
    await adminCreate(productBody({ name: `Filter A ${runId}` }));
    await adminCreate(productBody({ name: `Filter B ${runId}` }));
    await adminCreate(productBody({ name: `Other ${runId}`, category: `Other-${runId}` }));
    const res = await request(ENTRY).get(`/api/products?category=${encodeURIComponent(CATEGORY)}`);
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThanOrEqual(2);
    for (const p of res.body.products) expect(p.category).toBe(CATEGORY);
  });

  test('keyword search matches name/description', async () => {
    await adminCreate(productBody({
      name: `Searchable ${runId}`,
      description: `Contains zebra-token-${runId} inside`,
    }));
    const res = await request(ENTRY).get(`/api/products?search=zebra-token-${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe(`Searchable ${runId}`);
  });

  test('pagination works within a category', async () => {
    // Dedicated category -> exactly 3 products, deterministic pages.
    const pageCat = `PageCat-${runId}`;
    await adminCreate(productBody({ name: `Page A ${runId}`, category: pageCat }));
    await adminCreate(productBody({ name: `Page B ${runId}`, category: pageCat }));
    await adminCreate(productBody({ name: `Page C ${runId}`, category: pageCat }));
    const p1 = await request(ENTRY).get(`/api/products?category=${pageCat}&limit=2&page=1`);
    expect(p1.body.products).toHaveLength(2);
    expect(p1.body.total).toBe(3);
    expect(p1.body.pages).toBe(2);
    const p2 = await request(ENTRY).get(`/api/products?category=${pageCat}&limit=2&page=2`);
    expect(p2.body.products).toHaveLength(1);
  });

  test('GET /api/products/:id returns a single active product', async () => {
    const created = await adminCreate(productBody({ name: `Detail ${runId}` }));
    const res = await request(ENTRY).get(`/api/products/${created.body.product._id}`);
    expect(res.status).toBe(200);
    expect(res.body.product.name).toBe(`Detail ${runId}`);
    expect(res.body.service).toBe('products');
  });

  test('unknown id -> 404, malformed id -> 404', async () => {
    expect((await request(ENTRY).get('/api/products/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await request(ENTRY).get('/api/products/not-an-objectid')).status).toBe(404);
  });

  test('inactive products do not appear in browsing (detail 404 too)', async () => {
    const created = await adminCreate(productBody({ name: `Hidden ${runId}`, status: 'inactive' }));
    const id = created.body.product._id;
    const list = await request(ENTRY).get('/api/products');
    expect(list.body.products.some((p) => p._id === id)).toBe(false);
    expect((await request(ENTRY).get(`/api/products/${id}`)).status).toBe(404);
  });
});

describe('Admin product updates (PUT /api/products/:id)', () => {
  test('admin can update product details (persisted in shared MongoDB)', async () => {
    const created = await adminCreate(productBody({ name: `Updatable ${runId}`, stock: 7 }));
    const id = created.body.product._id;
    const res = await request(ENTRY)
      .put(`/api/products/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ price: 1234, description: 'Updated description', stock: 42 });
    expect(res.status).toBe(200);
    expect(res.body.product.price).toBe(1234);
    expect(res.body.product.stock).toBe(42);

    // Follow-up GET may be served by the OTHER instance -> shared MongoDB.
    const get = await request(ENTRY).get(`/api/products/${id}`);
    expect(get.body.product.price).toBe(1234);
    expect(get.body.product.stock).toBe(42);
    expect(get.body.product.description).toBe('Updated description');
  });

  test('invalid stock/price updates rejected with 400', async () => {
    const created = await adminCreate(productBody({ name: `Guarded ${runId}` }));
    const id = created.body.product._id;
    expect((await request(ENTRY).put(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ stock: -1 })).status).toBe(400);
    expect((await request(ENTRY).put(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ stock: 1.5 })).status).toBe(400);
    expect((await request(ENTRY).put(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ price: -10 })).status).toBe(400);
    expect((await request(ENTRY).put(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'bogus' })).status).toBe(400);
    // nothing was changed
    const get = await request(ENTRY).get(`/api/products/${id}`);
    expect(get.body.product.stock).toBe(10);
    expect(get.body.product.price).toBe(999);
  });

  test('renaming to an existing product name rejected with 409', async () => {
    const a = await adminCreate(productBody({ name: `Keep A ${runId}` }));
    const b = await adminCreate(productBody({ name: `Keep B ${runId}` }));
    const res = await request(ENTRY)
      .put(`/api/products/${a.body.product._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Keep B ${runId}` });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
    // Product B keeps its own record untouched.
    const bGet = await request(ENTRY).get(`/api/products/${b.body.product._id}`);
    expect(bGet.status).toBe(200);
    expect(bGet.body.product.name).toBe(`Keep B ${runId}`);
  });

  test('customers cannot update products (403)', async () => {
    const created = await adminCreate(productBody({ name: `Protected ${runId}` }));
    const res = await request(ENTRY)
      .put(`/api/products/${created.body.product._id}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ price: 1 });
    expect(res.status).toBe(403);
  });
});

describe('Admin soft deletion (DELETE /api/products/:id)', () => {
  test('delete sets status to discontinued without removing the record', async () => {
    const created = await adminCreate(productBody({ name: `Doomed ${runId}` }));
    const id = created.body.product._id;
    const res = await request(ENTRY).delete(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.product.status).toBe('discontinued');

    // Record still exists in MongoDB, but is invisible to customers.
    const inDb = await Product.findById(id).lean();
    expect(inDb).toBeTruthy();
    expect(inDb.status).toBe('discontinued');
    expect((await request(ENTRY).get(`/api/products/${id}`)).status).toBe(404);
    const list = await request(ENTRY).get('/api/products');
    expect(list.body.products.some((p) => p._id === id)).toBe(false);
  });

  test('delete is idempotent and 404s for unknown ids', async () => {
    const created = await adminCreate(productBody({ name: `Twice ${runId}` }));
    const id = created.body.product._id;
    expect((await request(ENTRY).delete(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
    const again = await request(ENTRY).delete(`/api/products/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(again.status).toBe(200);
    expect(again.body.message).toMatch(/already/i);
    expect((await request(ENTRY).delete('/api/products/aaaaaaaaaaaaaaaaaaaaaaaa').set('Authorization', `Bearer ${adminToken}`)).status).toBe(404);
  });

  test('customers cannot delete products (403)', async () => {
    const created = await adminCreate(productBody({ name: `Sticky ${runId}` }));
    const res = await request(ENTRY)
      .delete(`/api/products/${created.body.product._id}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
    const get = await request(ENTRY).get(`/api/products/${created.body.product._id}`);
    expect(get.status).toBe(200); // still active
  });
});

describe('Error hygiene', () => {
  test('admin operations on public route verify JWT: expired/invalid tokens -> 401', async () => {
    expect((await request(ENTRY).post('/api/products').set('Authorization', 'Bearer this.is.not.a.valid.jwt').send(productBody())).status).toBe(401);
    const expired = (await (await fetch(`${AUTH}/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'expired' }),
    })).json()).token;
    expect((await request(ENTRY).post('/api/products').set('Authorization', `Bearer ${expired}`).send(productBody())).status).toBe(401);
  });

  test('no internal errors or sensitive fields in product responses', async () => {
    const list = await request(ENTRY).get('/api/products');
    const raw = JSON.stringify(list.body);
    expect(raw).not.toMatch(/passwordHash|E11000|MongoError|stack("|')?:/i);
    const created = await adminCreate(productBody());
    expect(JSON.stringify(created.body)).not.toMatch(/passwordHash|E11000|MongoError/i);
  });
});
