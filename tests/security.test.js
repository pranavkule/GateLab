require('dotenv').config();
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = require('crypto').randomBytes(48).toString('hex');

const request = require('supertest');
const { spawnSync } = require('child_process');
const path = require('path');
const express = require('express');
const { createAuthApp } = require('../backend/auth/authService');
const { jwtAuthMiddleware } = require('../backend/middleware/jwtAuth');

const CP = 'http://localhost:15000';
const AUTH = 'http://localhost:15001';

function createProductionAuthApp() {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigins = process.env.ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_ORIGINS = 'https://store.example.test';
  try {
    return createAuthApp();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousOrigins;
  }
}

describe('Security baseline', () => {
  test('production JWT initialization fails clearly without a configured secret', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./backend/auth/jwt')"], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('JWT_SECRET is required');
  });

  test('production JWT initialization rejects short secrets', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./backend/auth/jwt')"], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'too-short' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('JWT_SECRET must be at least 32 bytes');
  });

  test('production database configuration requires credentials', () => {
    const mongo = spawnSync(process.execPath, ['-e', "require('./backend/db').connectDb().catch(e => { console.error(e.message); process.exit(2); })"], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', MONGO_URI: 'mongodb://127.0.0.1:27018/edgegate' },
    });
    expect(mongo.status).toBe(2);
    expect(mongo.stderr).toContain('MONGO_URI must include MongoDB credentials');

    const redis = spawnSync(process.execPath, ['-e', "require('./backend/redis')"], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6380' },
    });
    expect(redis.status).not.toBe(0);
    expect(redis.stderr).toContain('REDIS_URL must include a Redis password');
  });

  test('development seed commands refuse production execution', () => {
    const result = spawnSync(process.execPath, ['backend/scripts/seedData.js'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to seed development demo data in production');
  });

  test('production Auth Service omits development login, token, and plaintext verification routes', async () => {
    const app = createProductionAuthApp();
    expect((await request(app).post('/auth/login').send({})).status).toBe(404);
    expect((await request(app).post('/auth/token').send({})).status).toBe(404);
    expect((await request(app).post('/auth/verify').send({})).status).toBe(404);
    expect((await request(app).post('/auth/customer-login').send({})).status).toBe(400);
  });

  test('HTTP CORS rejects unapproved origins and reflects only configured origins', async () => {
    const app = createProductionAuthApp();
    const rejected = await request(app)
      .post('/auth/customer-login')
      .set('Origin', 'https://unapproved.example.test')
      .send({});
    expect(rejected.status).toBe(403);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await request(app)
      .post('/auth/customer-login')
      .set('Origin', 'https://store.example.test')
      .send({});
    expect(allowed.status).toBe(400);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://store.example.test');
  });

  test('gateway middleware removes client-supplied identity on public routes', async () => {
    const app = express();
    app.use(jwtAuthMiddleware(() => ({ authRequired: false })));
    app.get('/public', (req, res) => res.json({ identity: req.headers['x-auth-user'] || null }));

    const result = await request(app)
      .get('/public')
      .set('x-auth-user', encodeURIComponent(JSON.stringify({ sub: 'forged', role: 'admin' })));
    expect(result.status).toBe(200);
    expect(result.body.identity).toBeNull();
  });

  test('Control Plane requires an admin token for monitoring and mutations', async () => {
    const noToken = await request(CP).get('/api/status');
    expect(noToken.status).toBe(401);
    expect((await request(CP).get('/api/logs')).status).toBe(401);

    const demo = await fetch(`${CP}/api/demo-token?type=valid`);
    const adminToken = (await demo.json()).token;
    const admin = await request(CP).get('/api/status').set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);

    const email = `security-${Date.now()}@example.test`;
    const registration = await fetch(`${AUTH}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Security Test', email, password: 'SecurityTest123' }),
    });
    expect(registration.status).toBe(201);
    const login = await fetch(`${AUTH}/auth/customer-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'SecurityTest123' }),
    });
    const customerToken = (await login.json()).token;
    expect((await request(CP).get('/api/logs').set('Authorization', `Bearer ${customerToken}`)).status).toBe(403);
    expect((await request(CP).post('/api/reset').set('Authorization', `Bearer ${customerToken}`)).status).toBe(403);
  });

  test('Control Plane CORS rejects unapproved origins', async () => {
    const rejected = await request(CP)
      .get('/api/status')
      .set('Origin', 'https://unapproved.example.test');
    expect(rejected.status).toBe(403);

    const allowed = await request(CP)
      .get('/api/status')
      .set('Origin', 'http://localhost:5174');
    expect(allowed.status).toBe(401);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });
});
