/**
 * Gateway JWT middleware factory.
 *
 * A route is protected when its routing rule says authRequired: true.
 * Rejects with clean 401s for: missing, invalid and expired tokens.
 */
const { verifyToken } = require('../auth/jwt');

function jwtAuthMiddleware(getRouteForPath) {
  return (req, res, next) => {
    delete req.headers['x-auth-user'];
    const route = getRouteForPath(req.path);
    req.jwtStatus = 'none'; // public route, no JWT evaluated
    if (!route || !route.authRequired) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      req.jwtStatus = 'missing';
      return res.status(401).json({ error: 'unauthorized', message: 'Missing JWT token' });
    }

    const result = verifyToken(token);
    if (!result.ok) {
      req.jwtStatus = result.error === 'expired' ? 'expired' : 'invalid';
      return res.status(401).json({
        error: 'unauthorized',
        message: result.error === 'expired' ? 'JWT token has expired' : 'Invalid JWT token',
      });
    }

    req.jwtStatus = 'valid';
    req.user = result.payload; // subject, role, iat, exp
    // Forward auth context to the backend as required by the spec.
    req.headers['x-auth-user'] = encodeURIComponent(JSON.stringify({ sub: result.payload.sub, role: result.payload.role }));
    next();
  };
}

module.exports = { jwtAuthMiddleware };
