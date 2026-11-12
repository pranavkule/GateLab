require('dotenv').config();

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

if (typeof JWT_SECRET !== 'string' || JWT_SECRET.trim().length === 0) {
  throw new Error('JWT_SECRET is required; configure it in the local environment or production secret provider');
}
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(JWT_SECRET, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes in production');
}

function signToken(payload, options) {
  return jwt.sign(payload, JWT_SECRET, options);
}

function verifyToken(token) {
  // Returns { ok, payload, error } - never throws.
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
}

module.exports = { signToken, verifyToken, JWT_SECRET };
