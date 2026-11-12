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
process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(48).toString('hex');
process.env.DEMO_USER = 'edgegate-test-admin';
process.env.DEMO_PASSWORD = 'test-only-password-for-jest';

process.env.MONGO_URI = 'mongodb://127.0.0.1:27018/edgegate_test';
process.env.REDIS_URL = 'redis://localhost:6380';
process.env.BACKEND_INSTANCES = '14001:users,14002:users,14003:products,14004:orders';
process.env.GATEWAY_PORTS = '14101,14102';
process.env.HEALTH_CHECK_INTERVAL = '1000';
process.env.PROXY_TIMEOUT = '5000';

const { connectDb, disconnectDb } = require('../backend/db');
const manager = require('../backend/config/manager');
const { startServiceInstance } = require('../backend/services/microservice');
const { startGateway } = require('../backend/gateway/gateway');
const { startEntryLb } = require('../backend/gateway/entryLb');
const { createControlPlane } = require('../backend/controlPlane');
const { createAuthApp } = require('../backend/auth/authService');

const CP_URL = 'http://localhost:15000';

(async () => {
  await connectDb();
  const cfg = await manager.getLatest();
  if (!cfg) await manager.seedIfEmpty();

  const handles = [];
  handles.push(createControlPlane({ port: 15000 }));
  const authServer = require('http').createServer(createAuthApp());
  authServer.listen(15001);

  handles.push(await startServiceInstance({ port: 14001, service: 'users' }));
  handles.push(await startServiceInstance({ port: 14002, service: 'users' }));
  handles.push(await startServiceInstance({ port: 14003, service: 'products' }));
  handles.push(await startServiceInstance({ port: 14004, service: 'orders' }));
  handles.push(await startGateway({ port: 14101, name: 'gateway-14101', cpUrl: CP_URL }));
  handles.push(await startGateway({ port: 14102, name: 'gateway-14102', cpUrl: CP_URL }));
  handles.push(await startEntryLb({ port: 14100, gatewayPorts: [14101, 14102] }));

  console.log('[test-stack] ready on ports 14100-14102, 14001-14004, 15000-15001');

  async function shutdown() {
    for (const h of handles) { try { await h.close(); } catch (_) {} }
    try { await new Promise((r) => authServer.close(r)); } catch (_) {}
    try { await disconnectDb(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
})().catch((e) => { console.error('[test-stack] failed:', e.message); process.exit(1); });
