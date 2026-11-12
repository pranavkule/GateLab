/**
 * P1.4 tests: Order Service business logic.
 *
 * Covers order placement (validation, server-calculated totals, purchase
 * time snapshots), atomic inventory correctness (concurrency, no partial
 * deductions, no negative stock, idempotent re-submission), order access
 * rules (own orders only, admin override) and admin order management
 * (listing filters, validated status transitions, at-most-once stock
 * restore on cancellation) - all through the REAL gateway chain
 * (entry LB -> gateways -> reverse proxy -> service).
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
const CATEGORY = `OrdCat-${runId}`;

let adminToken = null;
let tokenA = null;   // customer A
let tokenB = null;   // customer B
let userA = null;    // UserProfile docs
let userB = null;

// Products (created per run with unique names).
let PA; let PB; let PC; let PZERO; let PINACT;

let orderIdA = null; // A's main order (multi-item)
let orderIdB = null; // B's order (for access-control tests)

function orderBody(items, extra = {}) {
  return { items, ...extra };
}

async function placeOrder(token, body) {
  return request(ENTRY).post('/api/orders').set('Authorization', `Bearer ${token}`).send(body);
}

async function login(email, password) {
  const res = await fetch(`${AUTH}/auth/customer-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json()).token;
}

async function stockOf(productId) {
  const doc = await Product.findById(productId).lean();
  return doc.stock;
}

beforeAll(async () => {
  await connectDb(TEST_DB);

  // Admin + two customers (upserts are idempotent, shared with other suites).
  await UserProfile.updateOne(
    { email: ADMIN_EMAIL },
    { $setOnInsert: { name: 'Lab Admin', email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'admin' } },
    { upsert: true }
  );
  const emailA = `order-a-${runId}@example.com`;
  const emailB = `order-b-${runId}@example.com`;
  await fetch(`${AUTH}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Order Tester A ${runId}`, email: emailA, password: 'Customer@123' }),
  });
  await fetch(`${AUTH}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Order Tester B ${runId}`, email: emailB, password: 'Customer@123' }),
  });
  userA = await UserProfile.findOne({ email: emailA }).lean();
  userB = await UserProfile.findOne({ email: emailB }).lean();
  adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  tokenA = await login(emailA, 'Customer@123');
  tokenB = await login(emailB, 'Customer@123');

  // Products with deterministic stock/price.
  const base = { category: CATEGORY, description: 'order test product' };
  PA = (await Product.create({ ...base, name: `Ord PA ${runId}`, price: 100, stock: 50 })).toObject();
  PB = (await Product.create({ ...base, name: `Ord PB ${runId}`, price: 250, stock: 5 })).toObject();
  PC = (await Product.create({ ...base, name: `Ord PC ${runId}`, price: 10, stock: 2 })).toObject();
  PZERO = (await Product.create({ ...base, name: `Ord PZERO ${runId}`, price: 50, stock: 0 })).toObject();
  PINACT = (await Product.create({ ...base, name: `Ord PINACT ${runId}`, price: 75, stock: 10, status: 'inactive' })).toObject();

  // B's order (for "cannot access another customer's order").
  const bOrder = await placeOrder(tokenB, orderBody([{ productId: String(PB._id), quantity: 1 }]));
  orderIdB = bOrder.body.order._id;
}, 20000);

afterAll(async () => {
  await disconnectDb();
});

describe('Order placement (POST /api/orders)', () => {
  test('unauthenticated request -> 401', async () => {
    const res = await request(ENTRY).post('/api/orders').send(orderBody([{ productId: String(PA._id), quantity: 1 }]));
    expect(res.status).toBe(401);
  });

  test('successful multi-item order with server-calculated total (201)', async () => {
    const res = await placeOrder(tokenA, orderBody([
      { productId: String(PA._id), quantity: 2 },
      { productId: String(PB._id), quantity: 1 },
    ]));
    expect(res.status).toBe(201);
    expect(res.body.service).toBe('orders');
    expect(res.body.order.status).toBe('pending');
    expect(res.body.order.totalAmount).toBe(100 * 2 + 250 * 1); // 450, from DB prices
    expect(res.body.order.user).toBe(String(userA._id));
    expect(res.body.order.items).toHaveLength(2);
    expect(res.body.order.items[0].name).toBe(PA.name);
    expect(res.body.order.items[0].price).toBe(100);
    expect(res.body.order.items[1].name).toBe(PB.name);
    expect(res.body.order.createdAt).toBeTruthy();
    orderIdA = res.body.order._id;

    // Stock decreased through the atomic deduction (verified via the public
    // product detail endpoint - through the gateway).
    // PB started at 5: -1 (B's beforeAll order) -1 (this order) = 3.
    const pa = await request(ENTRY).get(`/api/products/${PA._id}`);
    expect(pa.body.product.stock).toBe(48);
    const pb = await request(ENTRY).get(`/api/products/${PB._id}`);
    expect(pb.body.product.stock).toBe(3);
  });

  test('client-supplied prices, totals and user ids are never trusted', async () => {
    const res = await placeOrder(tokenA, orderBody(
      [{ productId: String(PA._id), quantity: 1, price: 0.01 }],
      { totalAmount: 1, user: String(userB._id), status: 'delivered' }
    ));
    expect(res.status).toBe(201);
    expect(res.body.order.totalAmount).toBe(100);          // DB price
    expect(res.body.order.user).toBe(String(userA._id));   // verified identity
    expect(res.body.order.status).toBe('pending');         // server-controlled
    expect(res.body.order.items[0].price).toBe(100);       // snapshot = DB price
  });

  test('invalid product id -> 400', async () => {
    expect((await placeOrder(tokenA, orderBody([{ productId: 'not-an-objectid', quantity: 1 }]))).status).toBe(400);
    expect((await placeOrder(tokenA, orderBody([{ productId: 'aaaaaaaaaaaaaaaaaaaa', quantity: 1 }]))).status).toBe(400);
  });

  test('missing product -> 404', async () => {
    const res = await placeOrder(tokenA, orderBody([{ productId: 'aaaaaaaaaaaaaaaaaaaaaaaa', quantity: 1 }]));
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found or not active/i);
  });

  test('inactive product cannot be ordered -> 404', async () => {
    const res = await placeOrder(tokenA, orderBody([{ productId: String(PINACT._id), quantity: 1 }]));
    expect(res.status).toBe(404);
  });

  test('invalid quantities -> 400', async () => {
    const fractional = 1.5;
    expect((await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 0 }]))).status).toBe(400);
    expect((await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: -2 }]))).status).toBe(400);
    expect((await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: fractional }]))).status).toBe(400);
    expect((await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 'two' }]))).status).toBe(400);
  });

  test('no items / empty items / too many items / duplicate ids -> 400', async () => {
    expect((await placeOrder(tokenA, orderBody([]))).status).toBe(400);
    expect((await placeOrder(tokenA, {})).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ productId: String(PA._id), quantity: 1 + i }));
    expect((await placeOrder(tokenA, orderBody(many))).status).toBe(400);
    const dup = await placeOrder(tokenA, orderBody([
      { productId: String(PA._id), quantity: 1 },
      { productId: String(PA._id), quantity: 1 },
    ]));
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/duplicate/i);
  });

  test('insufficient stock -> 409 with clear error, stock unchanged', async () => {
    const before = await stockOf(PZERO._id);
    const res = await placeOrder(tokenA, orderBody([{ productId: String(PZERO._id), quantity: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/insufficient stock/i);
    expect(await stockOf(PZERO._id)).toBe(before);
  });

  test('failed mixed order leaves NO partial deductions', async () => {
    const paBefore = await stockOf(PA._id);
    const res = await placeOrder(tokenA, orderBody([
      { productId: String(PA._id), quantity: 1 },     // available
      { productId: String(PZERO._id), quantity: 1 },  // out of stock -> abort
    ]));
    expect(res.status).toBe(409);
    expect(await stockOf(PA._id)).toBe(paBefore); // transaction rolled back the first deduction
  });
});

describe('Inventory correctness under concurrency', () => {
  test('concurrent competing orders: exactly one wins, stock never negative', async () => {
    expect(await stockOf(PC._id)).toBe(2);
    const body = orderBody([{ productId: String(PC._id), quantity: 2 }]);
    const [r1, r2] = await Promise.allSettled([
      placeOrder(tokenA, body),
      placeOrder(tokenB, body),
    ]);
    const statuses = [r1.value.status, r2.value.status].sort();
    expect(statuses).toEqual([201, 409]); // one committed, one aborted
    const finalStock = await stockOf(PC._id);
    expect(finalStock).toBe(0);           // never negative, no double deduction
  });
});

describe('Duplicate submission protection (clientRequestId)', () => {
  test('re-submitting the same clientRequestId returns the SAME order, deducts once', async () => {
    const key = `dup-${runId}`;
    const first = await placeOrder(tokenA, orderBody([{ productId: String(PB._id), quantity: 1 }], { clientRequestId: key }));
    expect(first.status).toBe(201);
    const stockAfterFirst = await stockOf(PB._id);
    // PB is at 3 at this point (5 - 1 B - 1 multi-item order); -1 now = 2.
    expect(stockAfterFirst).toBe(2);

    const second = await placeOrder(tokenA, orderBody([{ productId: String(PB._id), quantity: 1 }], { clientRequestId: key }));
    expect(second.status).toBe(200);
    expect(second.body.order._id).toBe(first.body.order._id);
    expect(second.body.message).toMatch(/already exists/i);
    expect(await stockOf(PB._id)).toBe(2); // no double deduction

    // Same key, different user -> separate order (per-user idempotency).
    const otherUser = await placeOrder(tokenB, orderBody([{ productId: String(PB._id), quantity: 1 }], { clientRequestId: key }));
    expect(otherUser.status).toBe(201);
    expect(otherUser.body.order._id).not.toBe(first.body.order._id);
  });
});

describe('Order access rules', () => {
  test('customer lists ONLY own orders, newest first', async () => {
    // A places a second order after orderIdA (so it must sort first).
    const second = await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 1 }]));
    expect(second.status).toBe(201);
    const res = await request(ENTRY).get('/api/orders').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('orders');
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const ids = res.body.orders.map((o) => o._id);
    expect(ids).toContain(orderIdA);
    expect(ids).not.toContain(orderIdB);
    expect(ids[0]).toBe(second.body.order._id); // newest first
    for (const o of res.body.orders) expect(o.user).toBe(String(userA._id));
  });

  test('customer cannot retrieve another customer order (403)', async () => {
    const res = await request(ENTRY).get(`/api/orders/${orderIdB}`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/another customer/i);
  });

  test('admin can retrieve any order', async () => {
    const res = await request(ENTRY).get(`/api/orders/${orderIdB}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.order._id).toBe(orderIdB);
  });

  test('unknown/malformed order ids -> 404', async () => {
    expect((await request(ENTRY).get('/api/orders/aaaaaaaaaaaaaaaaaaaaaaaa').set('Authorization', `Bearer ${tokenA}`)).status).toBe(404);
    expect((await request(ENTRY).get('/api/orders/garbage').set('Authorization', `Bearer ${tokenA}`)).status).toBe(404);
  });

  test('admin-only order listing (401/403 for others, filters + pagination for admin)', async () => {
    expect((await request(ENTRY).get('/api/orders/admin')).status).toBe(401);
    expect((await request(ENTRY).get('/api/orders/admin').set('Authorization', `Bearer ${tokenA}`)).status).toBe(403);

    const list = await request(ENTRY).get('/api/orders/admin').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.orders.length).toBeGreaterThanOrEqual(2); // seeded + test orders
    expect(typeof list.body.total).toBe('number');

    const pending = await request(ENTRY).get('/api/orders/admin?status=pending').set('Authorization', `Bearer ${adminToken}`);
    for (const o of pending.body.orders) expect(o.status).toBe('pending');
    const byUser = await request(ENTRY).get(`/api/orders/admin?user=${userB._id}`).set('Authorization', `Bearer ${adminToken}`);
    for (const o of byUser.body.orders) expect(o.user._id || o.user).toBe(String(userB._id));
    expect((await request(ENTRY).get('/api/orders/admin?status=bogus').set('Authorization', `Bearer ${adminToken}`)).status).toBe(400);
    expect((await request(ENTRY).get('/api/orders/admin?user=nope').set('Authorization', `Bearer ${adminToken}`)).status).toBe(400);
  });
});

describe('Admin status management', () => {
  test('invalid transitions and unknown statuses rejected (400)', async () => {
    expect((await request(ENTRY).put(`/api/orders/admin/${orderIdA}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'delivered' })).status).toBe(400); // pending -> delivered
    // Short form (no /admin segment) is also supported for admins.
    expect((await request(ENTRY).put(`/api/orders/${orderIdA}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'archived' })).status).toBe(400);
    expect((await request(ENTRY).put(`/api/orders/admin/${orderIdA}/status`).send({ status: 'confirmed' })).status).toBe(401); // no auth
    expect((await request(ENTRY).put(`/api/orders/admin/${orderIdA}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'confirmed' })).status).toBe(403); // customer
  });

  test('valid forward transitions succeed (pending -> confirmed -> ...)', async () => {
    const key = `fwd-${runId}`;
    const order = await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 1 }], { clientRequestId: key }));
    const id = order.body.order._id;
    const confirmed = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'confirmed' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.order.status).toBe('confirmed');
    const shipped = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'shipped' });
    expect(shipped.body.order.status).toBe('shipped');
    const delivered = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'delivered' });
    expect(delivered.body.order.status).toBe('delivered');
    const terminal = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' });
    expect(terminal.status).toBe(400); // delivered is terminal
    expect(terminal.body.message).toMatch(/terminal/i);
  });

  test('cancellation restores stock; repeated cancels restore at most once', async () => {
    // PB stock is 1 at this point (5 - 1 B - 1 multi-item - 1 dup-key A - 1 dup-key B).
    const order = await placeOrder(tokenA, orderBody([{ productId: String(PB._id), quantity: 1 }]));
    expect(order.status).toBe(201);
    expect(await stockOf(PB._id)).toBe(0);
    const id = order.body.order._id;

    const cancel = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.order.status).toBe('cancelled');
    expect(await stockOf(PB._id)).toBe(1); // +1 restored

    // Concurrent + repeated cancels: stock restored AT MOST once.
    const [again, concurrent] = await Promise.allSettled([
      request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' }),
      request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' }),
    ]);
    expect(again.value.status).toBe(200);
    expect(again.value.body.message).toMatch(/already cancelled/i);
    expect(concurrent.value.status).toBe(200);
    expect(await stockOf(PB._id)).toBe(1); // exactly one restore ever

    // Cancelled is terminal.
    const revive = await request(ENTRY).put(`/api/orders/admin/${id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'confirmed' });
    expect(revive.status).toBe(400);
  });
});

describe('Data integrity', () => {
  test('purchase-time snapshots survive later product price/name changes', async () => {
    const order = await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 1 }]));
    const id = order.body.order._id;
    // Admin changes the catalog price afterwards.
    await request(ENTRY).put(`/api/products/${PA._id}`).set('Authorization', `Bearer ${adminToken}`).send({ price: 133 });
    const res = await request(ENTRY).get(`/api/orders/${id}`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.order.items[0].price).toBe(100);          // snapshot, not 133
    expect(res.body.order.totalAmount).toBe(100);             // historical total
  });

  test('no internal errors or credential fields leak in order responses', async () => {
    const res = await request(ENTRY).get('/api/orders').set('Authorization', `Bearer ${tokenA}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/passwordHash|MongoError|MongoServerError|stack("|')?:/i);
    const placed = await placeOrder(tokenA, orderBody([{ productId: String(PA._id), quantity: 1 }]));
    expect(JSON.stringify(placed.body)).not.toMatch(/passwordHash|E11000|MongoError/i);
  });
});
