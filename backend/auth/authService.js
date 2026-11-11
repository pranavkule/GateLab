/**
 * Authentication service (:5001).
 *
 * POST /auth/login   { username, password } -> JWT (sub, role, iat, exp)
 * POST /auth/token   { type: valid|expired|invalid } -> demo tokens for the lab
 * POST /auth/verify  { token } -> { valid, payload | error }
 * GET  /auth/me      (Bearer token) -> payload
 *
 * The signing secret lives ONLY here and in the gateways (via env) -
 * never exposed to the frontend.
 */
const express = require('express');
const { User } = require('../models');
const { signToken, verifyToken } = require('./jwt');

function createAuthApp() {
  const app = express();
  app.use(express.json());

  const expiresIn = process.env.JWT_EXPIRES_IN || '1h';

  app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'bad_request', message: 'username and password required' });

    // Demo user from MongoDB, falling back to env credentials.
    let user = await User.findOne({ username }).lean();
    if (!user) {
      if (username === (process.env.DEMO_USER || 'admin') && password === (process.env.DEMO_PASSWORD || 'admin123')) {
        user = { username, role: 'student' };
      }
    }
    if (!user || (user.password != null && user.password !== password)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid username or password' });
    }
    const token = signToken({ sub: user.username, role: user.role || 'student' }, { expiresIn });
    res.json({ token, expiresIn, user: { username: user.username, role: user.role || 'student' } });
  });

  // Demo tokens so the lab can exercise every JWT failure mode.
  app.post('/auth/token', (req, res) => {
    const type = (req.body && req.body.type) || 'valid';
    if (type === 'valid') {
      return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn }) });
    }
    if (type === 'expired') {
      // Negative expiresIn -> already expired at signing time.
      return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn: '-10s' }) });
    }
    if (type === 'invalid') {
      return res.json({ token: 'this.is.not.a.valid.jwt' });
    }
    res.status(400).json({ error: 'bad_request', message: 'type must be valid|expired|invalid' });
  });

  app.post('/auth/verify', (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'bad_request', message: 'token required' });
    const result = verifyToken(token);
    res.json(result.ok ? { valid: true, payload: result.payload } : { valid: false, error: result.error });
  });

  app.get('/auth/me', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Missing token' });
    const result = verifyToken(token);
    if (!result.ok) return res.status(401).json({ error: 'unauthorized', message: result.error });
    res.json({ user: result.payload });
  });

  return app;
}

module.exports = { createAuthApp };
