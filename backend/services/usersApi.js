/**
 * User Service business logic (application layer).
 *
 * Identity model: the gateway verifies JWTs and forwards the verified auth
 * context upstream as `x-auth-user` (URI-encoded JSON: {sub, role}). Every
 * self-service endpoint resolves identity from that context - NEVER from a
 * client-supplied user id. `sub` is the UserProfile _id minted by
 * POST /auth/customer-login.
 *
 * Endpoints handled here (routed by the existing gateway configuration):
 *   GET /api/users/me   - own profile (authenticated e-commerce users)
 *   PUT /api/users/me   - update own profile (email/role/password immutable)
 *   GET /api/users/:id  - admin-only user lookup by id
 *
 * Registration / customer-login business logic (registerUser,
 * authenticateCustomer) also lives here; the auth service hosts thin public
 * endpoints for them because the gateway keeps /api/users/* JWT-protected
 * (existing routing config + tests) while sign-up and sign-in must be public.
 *
 * handle(req, res) returns true when it produced a response; unmatched paths
 * fall through to the service factory's legacy demo behaviour.
 */
const { UserProfile } = require('../models');
const { hashPassword, verifyPassword } = require('../utils/password');

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADDRESS_FIELDS = ['line1', 'city', 'state', 'postalCode', 'country'];

function httpError(status, message) {
  const code = { 400: 'validation_error', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
  return Object.assign(new Error(message), { status, code: code[status] || 'error' });
}

/** Strips credential/security fields - password hashes are never exposed. */
function publicUser(user) {
  if (!user) return null;
  const { passwordHash, __v, ...safe } = user;
  return safe;
}

function sanitizeAddress(input) {
  const out = {};
  for (const field of ADDRESS_FIELDS) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string') throw httpError(400, `address.${field} must be a string`);
    out[field] = input[field].trim();
  }
  return out;
}

/**
 * Registration business logic: validates required fields, normalizes the
 * email (trim + lowercase), scrypt-hashes the password and stores a
 * UserProfile. Role is always 'customer' - never client-controlled.
 */
async function registerUser(body) {
  const { name, email, password, phone, address } = body || {};
  const errors = [];
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) errors.push('name is required (2-80 characters)');
  if (typeof email !== 'string' || !EMAIL_RX.test(email.trim())) errors.push('a valid email is required');
  if (typeof password !== 'string' || password.length < 8) errors.push('password must be at least 8 characters');
  if (phone !== undefined && (typeof phone !== 'string' || phone.trim().length > 20)) errors.push('phone must be a string (max 20 characters)');
  if (address !== undefined && (typeof address !== 'object' || address === null || Array.isArray(address))) errors.push('address must be an object');
  if (errors.length) throw httpError(400, errors.join('; '));

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await UserProfile.findOne({ email: normalizedEmail }).lean();
  if (existing) throw httpError(409, 'Email already registered');

  const profile = {
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
    role: 'customer',
  };
  if (phone !== undefined) profile.phone = phone.trim();
  if (address !== undefined) profile.address = sanitizeAddress(address);

  try {
    const user = await UserProfile.create(profile);
    return publicUser(user.toObject());
  } catch (err) {
    // Unique index guards against concurrent registrations with the same email.
    if (err && err.code === 11000) throw httpError(409, 'Email already registered');
    throw err;
  }
}

/**
 * Customer login business logic. Returns the profile or null - callers must
 * respond identically for "unknown email" and "wrong password" (no
 * account enumeration).
 */
async function authenticateCustomer(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') throw httpError(400, 'email and password are required');
  const user = await UserProfile.findOne({ email: email.trim().toLowerCase() }).lean();
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  return publicUser(user);
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

async function findByIdSafe(id) {
  try {
    return await UserProfile.findById(id).lean();
  } catch (_) {
    return null; // malformed id / unknown subject
  }
}

async function getOwnProfile(req, res) {
  const ctx = authContext(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized', message: 'Verified authentication context required' });
  const user = await findByIdSafe(ctx.sub);
  if (!user) return res.status(404).json({ error: 'not_found', message: 'No e-commerce profile for the authenticated subject' });
  res.json({ user: publicUser(user) });
}

async function updateOwnProfile(req, res) {
  const ctx = authContext(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized', message: 'Verified authentication context required' });

  const user = await findByIdSafe(ctx.sub);
  if (!user) return res.status(404).json({ error: 'not_found', message: 'No e-commerce profile for the authenticated subject' });

  const body = req.body || {};
  const update = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 80) {
      return res.status(400).json({ error: 'validation_error', message: 'name must be 2-80 characters' });
    }
    update.name = body.name.trim();
  }
  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string' || body.phone.trim().length > 20) {
      return res.status(400).json({ error: 'validation_error', message: 'phone must be a string (max 20 characters)' });
    }
    update.phone = body.phone.trim();
  }
  if (body.address !== undefined) {
    if (typeof body.address !== 'object' || body.address === null || Array.isArray(body.address)) {
      return res.status(400).json({ error: 'validation_error', message: 'address must be an object' });
    }
    update.address = sanitizeAddress(body.address);
  }

  // email, role and passwordHash are deliberately NOT updatable here:
  // customers must never be able to change their own role or credentials.
  const updated = await UserProfile.findByIdAndUpdate(user._id, { $set: update }, { new: true, runValidators: true }).lean();
  res.json({ message: 'Profile updated', user: publicUser(updated) });
}

async function adminGetUser(req, res, id) {
  const ctx = authContext(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized', message: 'Verified authentication context required' });
  if (ctx.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
  const user = await findByIdSafe(id);
  if (!user) return res.status(404).json({ error: 'not_found', message: `No user with id ${id}` });
  res.json({ user: publicUser(user) });
}

/**
 * Entry point used by the service factory. Returns true when this request
 * was handled; false lets the factory keep its legacy demo behaviour
 * (existing tests and demos are unaffected).
 */
async function handle(req, res) {
  const BASE = '/api/users';
  if (!req.path.startsWith(BASE + '/')) return false;
  const rest = req.path.slice(BASE.length); // '/me', '/<id>', ...
  if (req.method === 'GET' && rest === '/me') { await getOwnProfile(req, res); return true; }
  if (req.method === 'PUT' && rest === '/me') { await updateOwnProfile(req, res); return true; }
  if (req.method === 'GET' && /^\/[0-9a-f]{24}$/i.test(rest)) { await adminGetUser(req, res, rest.slice(1)); return true; }
  // Unknown GET subpaths are real (missing) resources now, not demo data.
  if (req.method === 'GET') {
    return res.status(404).json({ error: 'not_found', message: `Unknown user resource: ${req.path}` }), true;
  }
  return false;
}

module.exports = { handle, registerUser, authenticateCustomer, publicUser };
