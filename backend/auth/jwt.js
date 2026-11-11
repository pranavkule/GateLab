const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'edgegate-dev-secret-change-in-production';

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
