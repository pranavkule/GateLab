/**
 * TEST SUITE (P2.6.2): graceful shutdown and resource cleanup.
 *
 * Covers the fixes found by the runtime smoke test:
 *   - the proxy's module-level keep-alive agent is destroyed on close
 *   - gateway / entry LB close() drain every pooled proxy socket
 *   - the control-plane health checker can be stopped before the workers
 *
 * Runs against the disposable Jest Mongo/Redis (same rules as the rest of
 * the suite); everything is bound to 127.0.0.1 on test-only ports.
 */
const http = require('http');
const { getTestMongoUri, getTestRedisUrl } = require('./testTargetSafety');

process.env.MONGO_URI = getTestMongoUri();
process.env.REDIS_URL = getTestRedisUrl();
process.env.BACKEND_INSTANCES = '14005:users';

const { startServiceInstance } = require('../backend/services/microservice');
const { startGateway } = require('../backend/gateway/gateway');
const { startEntryLb } = require('../backend/gateway/entryLb');
const { startHealthChecker } = require('../backend/health/checker');
const { agent, destroyAgent } = require('../backend/proxy');

const BACKEND_PORT = 14005;
const GATEWAY_PORT = 14103;
const ENTRY_PORT = 14104;
const TEST_ROUTES = [
  { id: 't-users', path: '/api/users/*', targetService: 'users', authRequired: false, enabled: true },
];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function freeSocketCount() {
  return Object.values(agent.freeSockets).reduce((n, sockets) => n + sockets.length, 0);
}

function openSocketCount() {
  return Object.values(agent.sockets).reduce((n, sockets) => n + sockets.length, 0);
}

let configServer;
let configPort;
let backend;
let gateway;
let entryLb;
let checkerServer;
let checkerHits;

beforeAll(async () => {
  configServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/config/latest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 1, routes: TEST_ROUTES }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(configServer);
  configPort = configServer.address().port;

  backend = await startServiceInstance({ port: BACKEND_PORT, service: 'users' });
  gateway = await startGateway({ port: GATEWAY_PORT, name: 'gateway-14103', cpUrl: `http://127.0.0.1:${configPort}` });
  await delay(100);
});

afterAll(async () => {
  if (entryLb) { await entryLb.close(); entryLb = null; }
  if (gateway) { await gateway.close(); gateway = null; }
  if (backend) await backend.close();
  if (configServer) await closeServer(configServer);
  if (checkerServer) await closeServer(checkerServer);
  destroyAgent();
  delete process.env.BACKEND_INSTANCES;
});

describe('proxy keep-alive agent (P2.6.2)', () => {
  test('gateway forwards a request and pools a free keep-alive socket', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/users`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await delay(150);
    expect(freeSocketCount() + openSocketCount()).toBeGreaterThan(0);
    expect(freeSocketCount()).toBeGreaterThan(0);
  });

  test('entry LB forwards through the gateway and close() drains its agent sockets', async () => {
    entryLb = await startEntryLb({ port: ENTRY_PORT, gatewayPorts: [GATEWAY_PORT] });
    const res = await fetch(`http://127.0.0.1:${ENTRY_PORT}/api/users`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await delay(150);
    expect(freeSocketCount() + openSocketCount()).toBeGreaterThan(0);
    await entryLb.close();
    entryLb = null;
    await delay(100);
    expect(freeSocketCount()).toBe(0);
    expect(openSocketCount()).toBe(0);
  });

  test('gateway close() drains every pooled proxy socket', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/users`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await delay(150);
    expect(freeSocketCount() + openSocketCount()).toBeGreaterThan(0);
    await gateway.close();
    gateway = null;
    await delay(100);
    expect(freeSocketCount()).toBe(0);
    expect(openSocketCount()).toBe(0);
  });
});

describe('control-plane health checker (P2.6.2)', () => {
  test('stops polling backends once stopped, so shutdown is not blocked by probes', async () => {
    checkerHits = 0;
    checkerServer = http.createServer((req, res) => {
      checkerHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'up' }));
    });
    await listen(checkerServer);
    const checkerPort = checkerServer.address().port;

    const health = startHealthChecker({
      backendPorts: { users: [checkerPort] },
      gatewayPorts: [],
      intervalMs: 50,
      onChange: () => {},
    });

    await delay(250);
    expect(checkerHits).toBeGreaterThan(0);

    health.close();
    await delay(500);
    const settled = checkerHits;
    await delay(500);
    expect(checkerHits).toBe(settled);
  });
});
