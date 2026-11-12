/**
 * Product Service business logic (application layer).
 *
 * Browsing is public (the /api/products/* gateway route keeps authRequired:
 * false, so existing tests and demo traffic are unaffected). Because the
 * gateway does not evaluate JWTs on public routes, it does NOT forward the
 * verified x-auth-user context here - so ADMIN operations verify the Bearer
 * token INSIDE the service using the SAME shared-secret verifyToken utility
 * the gateway middleware uses (same conventions, no gateway changes). The
 * role is read from the VERIFIED token payload only - never from the
 * request body or query string.
 *
 * Endpoints (routed by the existing gateway configuration):
 *   GET    /api/products        - active products (public; ?category=&search=&page=&limit=)
 *   GET    /api/products/:id    - single active product (public)
 *   POST   /api/products        - create product (admin)
 *   PUT    /api/products/:id    - update product details (admin)
 *   DELETE /api/products/:id    - soft delete -> status 'discontinued' (admin)
 *
 * Inventory safety (for P1.4): stock lives in MongoDB as a non-negative
 * integer and is only ever written with single atomic operations
 * (findByIdAndUpdate $set / $inc) - never read-then-write. Order placement
 * must deduct stock atomically, e.g.
 *   Product.findOneAndUpdate(
 *     { _id: id, status: 'active', stock: { $gte: qty } },
 *     { $inc: { stock: -qty } },
 *     { new: true })
 * so concurrent orders can never drive stock below zero.
 *
 * handle(req, res, port) returns true when it produced a response;
 * unmatched paths fall through to the service factory's legacy behaviour.
 */
const { Product } = require('../models');
const { verifyToken } = require('../auth/jwt');

const ID_RX = /^\/[0-9a-f]{24}$/i;
const STATUSES = ['active', 'inactive', 'discontinued'];
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

function httpError(status, message) {
  const code = { 400: 'validation_error', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
  return Object.assign(new Error(message), { status, code: code[status] || 'error' });
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCount(v, { label, integer = true, max }) {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '' || typeof v === 'object') {
    return { error: `${label} must be a number` };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (integer && !Number.isInteger(n)) return { error: `${label} must be an integer` };
  if (n < 0) return { error: `${label} must be >= 0` };
  if (max !== undefined && n > max) return { error: `${label} must be <= ${max}` };
  return { value: n };
}

/**
 * Validates product fields. partial=false (create) requires name, price and
 * category and defaults stock/description/status; partial=true (update)
 * validates only the provided fields.
 */
function validateProduct(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const value = {};

  if (b.name !== undefined || !partial) {
    if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.trim().length > 100) errors.push('name is required (2-100 characters)');
    else value.name = b.name.trim();
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.trim().length > 1000) errors.push('description must be a string (max 1000 characters)');
    else value.description = b.description.trim();
  } else if (!partial) value.description = '';

  if (b.price !== undefined || !partial) {
    const price = parseCount(b.price, { label: 'price', integer: false, max: 10000000 });
    if (price.error) errors.push(price.error);
    else value.price = price.value;
  }
  if (b.stock !== undefined) {
    const stock = parseCount(b.stock, { label: 'stock', integer: true, max: 1000000 });
    if (stock.error) errors.push(stock.error);
    else value.stock = stock.value;
  } else if (!partial) value.stock = 0;

  if (b.category !== undefined || !partial) {
    if (typeof b.category !== 'string' || b.category.trim().length < 2 || b.category.trim().length > 50) errors.push('category is required (2-50 characters)');
    else value.category = b.category.trim();
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) errors.push(`status must be one of: ${STATUSES.join(', ')}`);
    else value.status = b.status;
  } else if (!partial) value.status = 'active';

  return { errors, value };
}

/**
 * Verifies the Bearer JWT with the SAME utility/secret the gateway uses.
 * Returns { error, message } or { payload }. Role comes from the verified
 * payload only - body/query role fields are never trusted.
 */
function adminContext(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: 401, message: 'Admin authentication required (Bearer JWT)' };
  const result = verifyToken(token);
  if (!result.ok) {
    return { error: 401, message: result.error === 'expired' ? 'JWT token has expired' : 'Invalid JWT token' };
  }
  if (result.payload.role !== 'admin') return { error: 403, message: 'Admin role required' };
  return { payload: result.payload };
}

function authFailure(res, identity, auth) {
  return res.status(auth.error).json({
    ...identity,
    error: auth.error === 401 ? 'unauthorized' : 'forbidden',
    message: auth.message,
  });
}

function duplicateNameError(name) {
  return httpError(409, `Product '${name}' already exists`);
}

async function listProducts(req, res, identity) {
  const query = { status: 'active' }; // customers only ever browse active products

  if (req.query.category !== undefined) {
    if (typeof req.query.category !== 'string' || req.query.category.trim().length < 2 || req.query.category.trim().length > 50) {
      throw httpError(400, 'category filter must be 2-50 characters');
    }
    query.category = req.query.category.trim();
  }
  if (req.query.search !== undefined) {
    if (typeof req.query.search !== 'string' || req.query.search.trim().length < 1 || req.query.search.trim().length > 100) {
      throw httpError(400, 'search filter must be 1-100 characters');
    }
    const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
    query.$or = [{ name: rx }, { description: rx }];
  }

  let page = 1;
  let limit = DEFAULT_LIMIT;
  if (req.query.page !== undefined) {
    const p = parseCount(req.query.page, { label: 'page', max: 100000 });
    if (p.error || p.value < 1) throw httpError(400, 'page must be an integer >= 1');
    page = p.value;
  }
  if (req.query.limit !== undefined) {
    const l = parseCount(req.query.limit, { label: 'limit', max: MAX_LIMIT });
    if (l.error || l.value < 1) throw httpError(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    limit = l.value;
  }

  const [products, total] = await Promise.all([
    Product.find(query).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(query),
  ]);
  res.json({
    ...identity,
    timestamp: new Date().toISOString(),
    total, page, pages: Math.ceil(total / limit),
    products,
  });
}

async function getProduct(req, res, identity, id) {
  const product = await Product.findOne({ _id: id, status: 'active' }).lean();
  if (!product) throw httpError(404, 'Product not found');
  res.json({ ...identity, timestamp: new Date().toISOString(), product });
}

async function createProduct(req, res, identity) {
  const auth = adminContext(req);
  if (auth.error) return authFailure(res, identity, auth);

  const { errors, value } = validateProduct(req.body, { partial: false });
  if (errors.length) throw httpError(400, errors.join('; '));

  const existing = await Product.findOne({ name: value.name }).lean();
  if (existing) throw duplicateNameError(value.name);

  try {
    const product = await Product.create(value);
    res.status(201).json({ ...identity, timestamp: new Date().toISOString(), message: 'Product created', product: product.toObject() });
  } catch (err) {
    // Unique index guards against concurrent creations with the same name.
    if (err && err.code === 11000) throw duplicateNameError(value.name);
    throw err;
  }
}

async function updateProduct(req, res, identity, id) {
  const auth = adminContext(req);
  if (auth.error) return authFailure(res, identity, auth);

  const { errors, value } = validateProduct(req.body, { partial: true });
  if (errors.length) throw httpError(400, errors.join('; '));
  if (Object.keys(value).length === 0) throw httpError(400, 'No updatable fields provided');

  if (value.name !== undefined) {
    const clash = await Product.findOne({ name: value.name, _id: { $ne: id } }).lean();
    if (clash) throw duplicateNameError(value.name);
  }

  // Atomic single-operation update - never read-then-write (see P1.4 note).
  const updated = await Product.findByIdAndUpdate(id, { $set: value }, { new: true, runValidators: true }).lean();
  if (!updated) throw httpError(404, 'Product not found');
  res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Product updated', product: updated });
}

async function deleteProduct(req, res, identity, id) {
  const auth = adminContext(req);
  if (auth.error) return authFailure(res, identity, auth);

  // Soft delete per the model's status conventions - records are never
  // removed, so order history (P1.4) keeps valid product references.
  const updated = await Product.findOneAndUpdate(
    { _id: id, status: { $ne: 'discontinued' } },
    { $set: { status: 'discontinued' } },
    { new: true }
  ).lean();
  if (!updated) {
    const existing = await Product.findById(id).lean();
    if (!existing) throw httpError(404, 'Product not found');
    return res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Product already discontinued', product: existing });
  }
  res.json({ ...identity, timestamp: new Date().toISOString(), message: 'Product discontinued (soft delete)', product: updated });
}

/**
 * Entry point used by the service factory. Returns true when this request
 * was handled; unmatched non-GET paths fall through to the legacy demo
 * behaviour (existing tests and demos are unaffected).
 */
async function handle(req, res, port) {
  const BASE = '/api/products';
  if (!req.path.startsWith(BASE)) return false;
  const rest = req.path.slice(BASE.length); // '', '/<id>', ...
  const identity = { service: 'products', instance: port };

  let fn = null;
  let arg = null;
  if (req.method === 'GET' && rest === '') fn = listProducts;
  else if (req.method === 'GET' && ID_RX.test(rest)) { fn = getProduct; arg = rest.slice(1); }
  else if (req.method === 'POST' && rest === '') fn = createProduct;
  else if (req.method === 'PUT' && ID_RX.test(rest)) { fn = updateProduct; arg = rest.slice(1); }
  else if (req.method === 'DELETE' && ID_RX.test(rest)) { fn = deleteProduct; arg = rest.slice(1); }
  else if (req.method === 'GET') {
    // Unknown GET subpaths are real (missing) resources, not demo data.
    res.status(404).json({ ...identity, error: 'not_found', message: `Unknown product resource: ${req.path}` });
    return true;
  } else return false; // e.g. POST /api/products/<id> -> legacy echo

  try {
    await fn(req, res, identity, arg);
    return true;
  } catch (err) {
    if (res.headersSent) return true;
    const status = err && err.status ? err.status : 500;
    res.status(status).json({
      ...identity,
      error: (err && err.code) || 'internal_error',
      message: status >= 500 ? 'Unexpected product service error' : err.message,
    });
    return true;
  }
}

module.exports = { handle };
