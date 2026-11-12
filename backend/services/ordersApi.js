/**
 * Order Service business logic (application layer).
 *
 * Identity model: /api/orders/* is authRequired in the gateway routing
 * config, so the gateway verifies the JWT and forwards the verified auth
 * context upstream as `x-auth-user` (URI-encoded JSON: {sub, role}) - the
 * SAME convention the User Service uses. Identity and role are taken ONLY
 * from that verified context; client-supplied user ids, roles, prices,
 * totals and order status are never trusted.
 *
 * Endpoints handled here (all inside the existing /api/orders/* gateway
 * route - admin management therefore lives under /api/orders/admin because
 * /api/admin/* has no gateway route and routing config must stay unchanged):
 *   POST /api/orders                    - place an order (authenticated user)
 *   GET  /api/orders                    - own order history, newest first
 *   GET  /api/orders/:id                - own order (admins: any order)
 *   GET  /api/orders/admin              - admin order list (?status=&user=&page=&limit=)
 *   PUT  /api/orders/admin/:id/status   - admin status transition (validated)
 *
 * INVENTORY STRATEGY (the core requirement):
 *   Stock is deducted with a conditional atomic update per item:
 *     Product.findOneAndUpdate(
 *       { _id, status: 'active', stock: { $gte: quantity } },
 *       { $inc: { stock: -quantity } })
 *   inside ONE MongoDB transaction that also creates the order. Consequences:
 *     - stock can never go below zero (the $gte guard),
 *     - concurrent competing orders: a loser simply finds no matching doc,
 *     - a failed order rolls back ALL deductions (no partial inventory),
 *     - the order row only exists if every deduction committed (ACID).
 *   Transactions REQUIRE the single-node replica set configured in
 *   docker-compose.yml. If MongoDB is not a replica set the service returns
 *   a clean 503 explaining the requirement - it NEVER falls back to an
 *   unsafe read-then-write flow.
 *
 *   Cancellation restores stock with $inc inside the same transaction as
 *   the status change; the status change is a conditional
 *   findOneAndUpdate({ _id, status: { $in: ['pending','confirmed'] } }) so
 *   stock is restored AT MOST ONCE even under concurrent cancel requests.
 *
 * Duplicate submissions: an optional `clientRequestId` idempotency key
 * (unique per user) returns the already-created order on re-submission.
 *
 * handle(req, res, port) returns true when it produced a response;
 * unmatched paths fall through to the service factory's legacy behaviour.
 */
const mongoose = require('mongoose');
const { Order, Product } = require('../models');

const ID_RX = /^[0-9a-f]{24}$/i;
const MAX_ITEMS = 20;
const MAX_QTY = 10000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

// Valid lifecycle transitions (Order model statuses). delivered/cancelled
// are terminal.
const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};
const CANCELLABLE = ['pending', 'confirmed'];

function httpError(status, message) {
  const code = { 400: 'validation_error', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'service_unavailable' };
  return Object.assign(new Error(message), { status, code: code[status] || 'error' });
}

/** Verified gateway auth context (null when absent/unreadable). */
function authContext(req) {
  const raw = req.headers['x-auth-user'];
  if (!raw) return null;
  try {
    const ctx = JSON.parse(decodeURIComponent(raw));
    return ctx && ctx.sub ? ctx : null;
  } catch (_) {
    return null;
  }
}

function requireAuth(req, res) {
  const ctx = authContext(req);
  if (!ctx) {
    res.status(401).json({ error: 'unauthorized', message: 'Verified authentication context required' });
    return null;
  }
  return ctx;
}

function requireAdmin(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return null;
  if (ctx.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return null;
  }
  return ctx;
}

/** Detects "MongoDB is not a replica set" failures -> clean 503, no fallback. */
function isTransactionUnsupported(err) {
  const msg = String(err && err.message);
  return /Transaction numbers|replica set|not running with --replSet/i.test(msg);
}

/**
 * Validates and normalizes order items. Rules:
 *   - items must be a non-empty array (max 20),
 *   - every productId must be a valid 24-hex id,
 *   - every quantity must be a positive integer (max 10000),
 *   - duplicate product ids are rejected (one line item per product).
 * Client price/total fields are ignored entirely - prices come from the DB.
 */
function validateItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1) throw httpError(400, 'items must be a non-empty array');
  if (rawItems.length > MAX_ITEMS) throw httpError(400, `too many items (max ${MAX_ITEMS})`);
  const items = [];
  const seen = new Set();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'each item must be an object');
    if (typeof raw.productId !== 'string' || !ID_RX.test(raw.productId)) throw httpError(400, 'each item needs a valid productId (24 hex characters)');
    if (typeof raw.quantity === 'boolean' || raw.quantity === null || raw.quantity === undefined || raw.quantity === '') {
      throw httpError(400, 'each item needs a quantity');
    }
    const qty = Number(raw.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw httpError(400, 'quantity must be a positive integer');
    if (seen.has(raw.productId)) throw httpError(400, 'duplicate product ids in one order are not allowed (one line item per product)');
    seen.add(raw.productId);
    items.push({ productId: raw.productId, quantity: qty });
  }
  return items;
}

function publicOrder(order) {
  if (!order) return null;
  const { __v, ...safe } = order;
  return safe;
}

function parsePagination(query) {
  let page = 1;
  let limit = DEFAULT_LIMIT;
  const errors = [];
  if (query.page !== undefined) {
    const p = Number(query.page);
    if (!Number.isInteger(p) || p < 1 || p > 100000) errors.push('page must be an integer >= 1');
    else page = p;
  }
  if (query.limit !== undefined) {
    const l = Number(query.limit);
    if (!Number.isInteger(l) || l < 1 || l > MAX_LIMIT) errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    else limit = l;
  }
  if (errors.length) throw httpError(400, errors.join('; '));
  return { page, limit };
}

async function placeOrder(req, res, identity) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;

  const items = validateItems((req.body || {}).items);
  const clientRequestId = (req.body || {}).clientRequestId;
  if (clientRequestId !== undefined) {
    if (typeof clientRequestId !== 'string' || clientRequestId.trim().length === 0 || clientRequestId.trim().length > 64) {
      return res.status(400).json({ ...identity, error: 'validation_error', message: 'clientRequestId must be a string (1-64 characters)' });
    }
  }
  const requestId = clientRequestId ? clientRequestId.trim() : undefined;

  // Fetch products FIRST (outside the transaction) to produce friendly
  // validation errors without paying rollback cost. The transaction re-reads
  // stock atomically anyway, so this pre-check cannot create a race.
  let productIds;
  try {
    productIds = items.map((i) => new mongoose.Types.ObjectId(i.productId));
  } catch (_) {
    return res.status(400).json({ ...identity, error: 'validation_error', message: 'each item needs a valid productId (24 hex characters)' });
  }
  const catalog = await Product.find({ _id: { $in: productIds }, status: 'active' }).lean();
  const byId = new Map(catalog.map((p) => [String(p._id), p]));
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p) {
      return res.status(404).json({ ...identity, error: 'not_found', message: `Product ${item.productId} not found or not active` });
    }
  }

  let session;
  try {
    session = await mongoose.connection.startSession();
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return res.status(503).json({
        ...identity,
        error: 'service_unavailable',
        message: 'Order placement requires MongoDB transactions (single-node replica set). Start the stack with docker compose up -d (see README).',
      });
    }
    throw err;
  }

  let outcome;
  try {
    await session.withTransaction(async () => {
      // Idempotency fast path: same user + same clientRequestId -> return
      // the existing order, no new deductions.
      if (requestId) {
        const existing = await Order.findOne({ user: ctx.sub, clientRequestId: requestId }).session(session);
        if (existing) { outcome = { duplicate: existing.toObject() }; return; }
      }

      // Atomic conditional deduction per item. A concurrent competing order
      // simply finds no matching document -> transaction aborts and ALL
      // deductions of THIS request roll back too (no partial inventory).
      const snapshots = [];
      for (const item of items) {
        const p = byId.get(item.productId);
        const deducted = await Product.findOneAndUpdate(
          { _id: p._id, status: 'active', stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { new: true, session }
        );
        if (!deducted) {
          throw httpError(409, `Insufficient stock for '${p.name}' (requested ${item.quantity}, available ${p.stock})`);
        }
        snapshots.push({ product: p._id, name: p.name, price: p.price, quantity: item.quantity });
      }

      // Prices/total ALWAYS from the database (never client input).
      const totalAmount = snapshots.reduce((sum, s) => sum + s.price * s.quantity, 0);

      try {
        const doc = { user: ctx.sub, items: snapshots, totalAmount, status: 'pending' };
        // Only set the field when present - never stored as null/undefined.
        if (requestId) doc.clientRequestId = requestId;
        const created = await Order.create([doc], { session });
        outcome = { created: created[0].toObject() };
      } catch (err) {
        // Lost a race against a concurrent duplicate submission: its commit
        // created the order and aborted this transaction (stock untouched).
        if (err && err.code === 11000 && requestId) {
          const existing = await Order.findOne({ user: ctx.sub, clientRequestId: requestId }).session(session);
          if (existing) { outcome = { duplicate: existing.toObject() }; return; }
        }
        throw err;
      }
    });
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return res.status(503).json({
        ...identity,
        error: 'service_unavailable',
        message: 'Order placement requires MongoDB transactions (single-node replica set). Start the stack with docker compose up -d (see README).',
      });
    }
    const status = err && err.status ? err.status : 500;
    if (res.headersSent) return;
    return res.status(status).json({
      ...identity,
      error: (err && err.code) || 'internal_error',
      message: status >= 500 ? 'Unexpected order service error' : err.message,
    });
  } finally {
    await session.endSession();
  }

  if (outcome.duplicate) {
    return res.json({
      ...identity,
      timestamp: new Date().toISOString(),
      message: 'Order already exists for this clientRequestId (idempotent response)',
      order: publicOrder(outcome.duplicate),
    });
  }
  res.status(201).json({
    ...identity,
    timestamp: new Date().toISOString(),
    message: 'Order placed',
    order: publicOrder(outcome.created),
  });
}

async function listOwnOrders(req, res, identity) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const { page, limit } = parsePagination(req.query);
  const query = { user: ctx.sub };
  const [orders, total] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(query),
  ]);
  res.json({
    ...identity,
    timestamp: new Date().toISOString(),
    total, page, pages: Math.ceil(total / limit),
    orders,
  });
}

async function getOrder(req, res, identity, id) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const order = await Order.findById(id).lean();
  if (!order) return res.status(404).json({ ...identity, error: 'not_found', message: 'Order not found' });
  // Customers may only see their own orders; admins may see any order.
  if (ctx.role !== 'admin' && String(order.user) !== String(ctx.sub)) {
    return res.status(403).json({ ...identity, error: 'forbidden', message: 'This order belongs to another customer' });
  }
  res.json({ ...identity, timestamp: new Date().toISOString(), order: publicOrder(order) });
}

async function adminListOrders(req, res, identity) {
  const ctx = requireAdmin(req, res);
  if (!ctx) return;
  const query = {};
  if (req.query.status !== undefined) {
    if (!ORDER_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ ...identity, error: 'validation_error', message: `status filter must be one of: ${ORDER_STATUSES.join(', ')}` });
    }
    query.status = req.query.status;
  }
  if (req.query.user !== undefined) {
    if (typeof req.query.user !== 'string' || !ID_RX.test(req.query.user)) {
      return res.status(400).json({ ...identity, error: 'validation_error', message: 'user filter must be a valid user id (24 hex characters)' });
    }
    query.user = req.query.user;
  }
  const { page, limit } = parsePagination(req.query);
  const [orders, total] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name email').lean(),
    Order.countDocuments(query),
  ]);
  res.json({
    ...identity,
    timestamp: new Date().toISOString(),
    total, page, pages: Math.ceil(total / limit),
    orders,
  });
}

async function adminUpdateStatus(req, res, identity, id) {
  const ctx = requireAdmin(req, res);
  if (!ctx) return;

  const next = (req.body || {}).status;
  if (typeof next !== 'string' || !ORDER_STATUSES.includes(next)) {
    return res.status(400).json({ ...identity, error: 'validation_error', message: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
  }

  const order = await Order.findById(id).lean();
  if (!order) return res.status(404).json({ ...identity, error: 'not_found', message: 'Order not found' });

  const allowed = TRANSITIONS[order.status] || [];
  // Repeated cancels (sequential or after a concurrent winner committed) are
  // idempotent: stock was already restored exactly once, nothing to change.
  if (next === 'cancelled' && order.status === 'cancelled') {
    return res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Order was already cancelled (stock restored at most once)', order: publicOrder(order) });
  }
  if (!allowed.includes(next)) {
    return res.status(400).json({
      ...identity,
      error: 'validation_error',
      message: `Cannot change status from '${order.status}' to '${next}' (allowed: ${allowed.length ? allowed.join(', ') : 'nothing - terminal status'})`,
    });
  }

  if (next !== 'cancelled') {
    // No inventory involved: a single atomic conditional update suffices.
    const updated = await Order.findOneAndUpdate({ _id: id, status: order.status }, { $set: { status: next } }, { new: true }).lean();
    if (!updated) return res.status(409).json({ ...identity, error: 'conflict', message: 'Order status changed concurrently, retry' });
    return res.json({ ...identity, timestamp: new Date().toISOString(), message: `Order status updated to '${next}'`, order: publicOrder(updated) });
  }

  // Cancellation MUST restore stock - in the SAME transaction as the status
  // change. The conditional transition matches at most once (concurrent
  // losers see status already 'cancelled'), so stock is restored AT MOST
  // ONCE no matter how many cancel requests race.
  let session;
  try {
    session = await mongoose.connection.startSession();
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return res.status(503).json({ ...identity, error: 'service_unavailable', message: 'Cancellation requires MongoDB transactions (single-node replica set). Start the stack with docker compose up -d (see README).' });
    }
    throw err;
  }

  let outcome;
  try {
    await session.withTransaction(async () => {
      const cancelled = await Order.findOneAndUpdate(
        { _id: id, status: { $in: CANCELLABLE } },
        { $set: { status: 'cancelled' } },
        { new: true, session }
      );
      if (!cancelled) {
        // Another concurrent request cancelled it first (or it is terminal).
        const current = await Order.findById(id).session(session).lean();
        outcome = { already: current };
        return;
      }
      // Restore every item's stock. Orders keep purchase-time snapshots, so
      // restocking uses the stored quantity - independent of any later
      // catalog changes.
      for (const item of cancelled.items) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
      }
      outcome = { cancelled: cancelled.toObject() };
    });
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return res.status(503).json({ ...identity, error: 'service_unavailable', message: 'Cancellation requires MongoDB transactions (single-node replica set). Start the stack with docker compose up -d (see README).' });
    }
    const status = err && err.status ? err.status : 500;
    if (res.headersSent) return;
    return res.status(status).json({ ...identity, error: (err && err.code) || 'internal_error', message: status >= 500 ? 'Unexpected order service error' : err.message });
  } finally {
    await session.endSession();
  }

  if (outcome.already) {
    return res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Order was already cancelled (stock restored at most once)', order: publicOrder(outcome.already) });
  }
  res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Order cancelled, stock restored', order: publicOrder(outcome.cancelled) });
}

/**
 * Entry point used by the service factory. Returns true when this request
 * was handled; false lets the factory keep its legacy demo behaviour
 * (e.g. routing.test.js repointing /api/products/* at this service).
 */
async function handle(req, res, port) {
  const BASES = ['/api/orders', '/api/admin/orders']; // second base is future-proofing: no gateway route exists for it today
  let base = null;
  let rest = null;
  for (const b of BASES) {
    if (req.path === b) { base = b; rest = ''; break; }
    if (req.path.startsWith(b + '/')) { base = b; rest = req.path.slice(b.length); break; }
  }
  if (!base) return false;

  const identity = { service: 'orders', instance: port };
  const isAdminBase = base === '/api/admin/orders';
  // Admin status update: PUT /api/orders/admin/<id>/status (primary) and
  // PUT /api/orders/<id>/status (short form). Under /api/admin/orders only
  // the short form applies (the base already carries the admin prefix).
  const STATUS_RX = isAdminBase
    ? /^\/([0-9a-f]{24})\/status$/i
    : /^\/(?:admin\/)?([0-9a-f]{24})\/status$/i;

  let fn = null;
  let arg = null;
  if (isAdminBase) {
    if (req.method === 'GET' && rest === '') fn = adminListOrders;
    else if (req.method === 'PUT' && STATUS_RX.test(rest)) { fn = adminUpdateStatus; arg = rest.match(STATUS_RX)[1]; }
    else return false; // unmatched non-GET -> legacy echo (factory behaviour)
  } else if (req.method === 'POST' && rest === '') fn = placeOrder;
  else if (req.method === 'GET' && rest === '') fn = listOwnOrders;
  else if (req.method === 'GET' && rest === '/admin') fn = adminListOrders;
  else if (req.method === 'PUT' && STATUS_RX.test(rest)) { fn = adminUpdateStatus; arg = rest.match(STATUS_RX)[1]; }
  else if (req.method === 'GET' && /^\/[0-9a-f]{24}$/i.test(rest)) { fn = getOrder; arg = rest.slice(1); }
  else if (req.method === 'GET') {
    // Unknown GET subpaths are real (missing) resources, not demo data.
    res.status(404).json({ ...identity, error: 'not_found', message: `Unknown order resource: ${req.path}` });
    return true;
  } else return false; // e.g. POST /api/orders/<id> -> legacy echo

  try {
    await fn(req, res, identity, arg);
    return true;
  } catch (err) {
    if (res.headersSent) return true;
    const status = err && err.status ? err.status : 500;
    res.status(status).json({
      ...identity,
      error: (err && err.code) || 'internal_error',
      message: status >= 500 ? 'Unexpected order service error' : err.message,
    });
    return true;
  }
}

module.exports = { handle, TRANSITIONS, ORDER_STATUSES };
