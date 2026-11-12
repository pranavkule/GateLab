/**
 * Authentication service (:5011).
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
const { registerUser, authenticateCustomer } = require('../services/usersApi');
const { corsMiddleware } = require('../security/cors');

function createAuthApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(corsMiddleware());
  app.use(express.json({ limit: '256kb' }));

  const expiresIn = process.env.JWT_EXPIRES_IN || '1h';

  if (!isProduction) {
    app.post('/auth/login', async (req, res, next) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'bad_request', message: 'username and password required' });

        const demoUser = process.env.DEMO_USER;
        const demoPassword = process.env.DEMO_PASSWORD;
        const isConfiguredDemo = Boolean(demoUser && demoPassword) &&
          username === demoUser && password === demoPassword;
        const user = isConfiguredDemo
          ? { username, role: 'admin' }
          : await User.findOne({ username }).lean();

        if (!user || (!isConfiguredDemo && user.password !== password)) {
          return res.status(401).json({ error: 'unauthorized', message: 'Invalid username or password' });
        }
        const token = signToken({ sub: user.username, role: user.role || 'student' }, { expiresIn });
        res.json({ token, expiresIn, user: { username: user.username, role: user.role || 'student' } });
      } catch (e) { next(e); }
    });

    app.post('/auth/token', (req, res) => {
      const type = (req.body && req.body.type) || 'valid';
      if (type === 'valid') {
        return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn }) });
      }
      if (type === 'expired') {
        return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn: '-10s' }) });
      }
      if (type === 'invalid') return res.json({ token: 'this.is.not.a.valid.jwt' });
      res.status(400).json({ error: 'bad_request', message: 'type must be valid|expired|invalid' });
    });

    app.post('/auth/verify', (req, res) => {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ error: 'bad_request', message: 'token required' });
      const result = verifyToken(token);
      res.json(result.ok ? { valid: true, payload: result.payload } : { valid: false, error: result.error });
    });
  }

  // --- E-commerce (UserProfile) endpoints.
  // Business logic lives in services/usersApi.js; these are thin PUBLIC
  // endpoints because the gateway requires JWT for every /api/users/* route
  // (existing routing config is unchanged) while registration and login must
  // be reachable without a token. Both reuse the SAME JWT mechanism (same
  // signToken / JWT_SECRET / expiry) - no competing token scheme.
  app.post('/auth/register', async (req, res, next) => {
    try {
      const user = await registerUser(req.body);
      res.status(201).json({ message: 'Registration successful', user });
    } catch (e) { next(e); }
  });

  app.post('/auth/customer-login', async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const user = await authenticateCustomer(email, password);
      if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Invalid email or password' });
      const token = signToken({ sub: user._id, role: user.role, email: user.email }, { expiresIn });
      res.json({ token, expiresIn, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
    } catch (e) { next(e); }
  });

  app.get('/auth/me', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Missing token' });
    const result = verifyToken(token);
    if (!result.ok) return res.status(401).json({ error: 'unauthorized', message: result.error });
    res.json({ user: result.payload });
  });

  // Error handler - clean JSON, no stack traces. Business logic throws
  // errors carrying .status/.code (see services/usersApi.js).
  app.use((err, req, res, next) => {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({
      error: (err && err.code) || (status >= 500 ? 'internal_error' : 'bad_request'),
      message: status >= 500 ? 'Unexpected auth service error' : err.message,
    });
  });

  return app;
}

module.exports = { createAuthApp };
