const cors = require('cors');

const DEVELOPMENT_ORIGINS = ['http://localhost:5174', 'http://127.0.0.1:5174'];

function getAllowedOrigins() {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return [...new Set(configured)];
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ALLOWED_ORIGINS must be configured in production');
  }
  return DEVELOPMENT_ORIGINS;
}

function isAllowedOrigin(origin) {
  return !origin || getAllowedOrigins().includes(origin);
}

function corsMiddleware() {
  const allowedOrigins = getAllowedOrigins();
  const middleware = cors({
    origin(origin, callback) {
      callback(null, origin ? allowedOrigins.includes(origin) && origin : false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });

  return (req, res, next) => {
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    return middleware(req, res, next);
  };
}

function getCorsHeaders(origin) {
  const allowedOrigins = getAllowedOrigins();
  if (origin && !allowedOrigins.includes(origin)) return null;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

module.exports = { corsMiddleware, getAllowedOrigins, getCorsHeaders, isAllowedOrigin };
