/**
 * Test-only stack runner (spawned by tests/globalSetup.js).
 *
 * Boots a miniature EdgeGate stack on dedicated test ports so automated
 * tests never collide with the dev stack:
 *   backends : 14001(users) 14002(users) 14003(products) 14004(orders)
 *   gateways : 14101, 14102
 *   entry LB : 14100
 *   control  : 15000    auth: 15001
 * Uses a separate MongoDB database (edgegate_test).
 */
require('dotenv').config();
const { getTestMongoUri, getTestRedisUrl } = require('./testTargetSafety');
process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(48).toString('hex');
process.env.DEMO_USER = 'edgegate-test-admin';
process.env.DEMO_PASSWORD = 'test-only-password-for-jest';

process.env.MONGO_URI = getTestMongoUri();
process.env.REDIS_URL = getTestRedisUrl();
process.env.BACKEND_INSTANCES = '14001:users,14002:users,14003:products,14004:orders';
process.env.GATEWAY_PORTS = '14101,14102';
process.env.HEALTH_CHECK_INTERVAL = '1000';
process.env.PROXY_TIMEOUT = '5000';
// Circuit-breaker settings for the test stack (P2.5.1): short cooldown so
// OPEN -> HALF-OPEN transitions are testable quickly, and 2 probes so the
// shared probe limit is observable.
process.env.CB_FAILURE_THRESHOLD = '5';
process.env.CB_COOLDOWN_MS = '2000';
process.env.CB_HALF_OPEN_PROBES = '2';
// Auth throttle (P2.6.1): generous limits so existing suites (which each make
// a handful of register/login calls) never trip the throttle; the dedicated
// auth-throttle suite drives real 429s on an in-process app with low limits.
process.env.AUTH_LOGIN_RATE_LIMIT = '25';
process.env.AUTH_REGISTER_RATE_LIMIT = '25';
process.env.AUTH_RATE_WINDOW_MS = '60000';

const { connectDb, disconnectDb } = require('../backend/db');
const manager = require('../backend/config/manager');
const { startServiceInstance } = require('../backend/services/microservice');
const { startGateway } = require('../backend/gateway/gateway');
const { startEntryLb } = require('../backend/gateway/entryLb');
const { createControlPlane } = require('../backend/controlPlane');
const { createAuthApp } = require('../backend/auth/authService');
const { createRedis } = require('../backend/redis');
const { User, UserProfile } = require('../backend/models');
const { hashPassword } = require('../backend/utils/password');

const CP_URL = 'http://localhost:15000';
const handles = [];
let redis;
let authServer;
let dbConnectionStarted = false;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  let cleanupFailed = false;

  async function closeResource(name, close) {
    try {
      await close();
    } catch (error) {
      cleanupFailed = true;
      console.error(`[test-stack] failed to close ${name}: ${error.message}`);
    }
  }

  for (const handle of [...handles].reverse()) {
    await closeResource('stack resource', () => handle.close());
  }
  if (authServer && authServer.listening) {
    await closeResource('auth server', () => new Promise((resolve, reject) => {
      authServer.close((error) => error ? reject(error) : resolve());
    }));
  }
  if (redis) await closeResource('auth Redis client', () => redis.quit());
  if (dbConnectionStarted) await closeResource('MongoDB connection', () => disconnectDb());

  process.exit(exitCode || (cleanupFailed ? 1 : 0));
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('message', (message) => { if (message === 'shutdown') shutdown(); });

(async () => {
  dbConnectionStarted = true;
  await connectDb();
  const cfg = await manager.getLatest();
  if (!cfg) await manager.seedIfEmpty();
  await User.updateOne(
    { username: 'edgegate-test-student' },
    {
      $set: {
        username: 'edgegate-test-student',
        passwordHash: await hashPassword('test-only-student-password'),
        role: 'student',
      },
      $unset: { password: '' },
    },
    { upsert: true }
  );
  await UserProfile.updateOne(
    { email: 'lab-admin@example.test' },
    {
      $setOnInsert: {
        name: 'Lab Admin',
        email: 'lab-admin@example.test',
        passwordHash: await hashPassword('TestAdminPassword123'),
        role: 'admin',
      },
    },
    { upsert: true }
  );

  handles.push(createControlPlane({ port: 15000 }));
  redis = createRedis();
  authServer = require('http').createServer(createAuthApp({ redis }));
  authServer.listen(15001);

  handles.push(await startServiceInstance({ port: 14001, service: 'users' }));
  handles.push(await startServiceInstance({ port: 14002, service: 'users' }));
  handles.push(await startServiceInstance({ port: 14003, service: 'products' }));
  handles.push(await startServiceInstance({ port: 14004, service: 'orders' }));
  handles.push(await startGateway({ port: 14101, name: 'gateway-14101', cpUrl: CP_URL }));
  handles.push(await startGateway({ port: 14102, name: 'gateway-14102', cpUrl: CP_URL }));
  handles.push(await startEntryLb({ port: 14100, gatewayPorts: [14101, 14102] }));

  console.log('[test-stack] ready on ports 14100-14102, 14001-14004, 15000-15001');
})().catch(async (error) => {
  console.error('[test-stack] failed:', error.message);
  await shutdown(1);
});
