/**
 * EdgeGate process launcher.
 *
 * Uses Node's cluster module so every component runs in its OWN OS process
 * (true isolation - no shared mutable routing state between gateways):
 *
 *   primary : control plane (:5010, REST + Socket.IO + MongoDB/Redis links)
 *             auth service (:5011)
 *   workers : entry LB (:3010), 3 gateways (:3011-3013), 6 backends (4011-4016)
 */
require('dotenv').config();
const cluster = require('cluster');
require('./auth/jwt');
require('./security/cors').getAllowedOrigins();

const CONTROL_PORT = Number(process.env.CONTROL_PLANE_PORT) || 5010;
const AUTH_PORT = Number(process.env.AUTH_PORT) || 5011;
const ENTRY_PORT = Number(process.env.ENTRY_LB_PORT) || 3010;
const GATEWAY_PORTS = (process.env.GATEWAY_PORTS || '3011,3012,3013').split(',').map(Number);
const CP_URL = `http://localhost:${CONTROL_PORT}`;

function parseBackends() {
  const raw = process.env.BACKEND_INSTANCES || '4011:users,4014:users,4012:products,4015:products,4013:orders,4016:orders';
  return raw.split(',').map((s) => {
    const [port, service] = s.trim().split(':');
    return { port: Number(port), service };
  });
}

if (cluster.isPrimary) {
  (async () => {
    const { connectDb, disconnectDb } = require('./db');
    const manager = require('./config/manager');
    await connectDb();
    await manager.seedIfEmpty();

    // Control plane + auth live in the primary process.
    const { createControlPlane } = require('./controlPlane');
    const { createAuthApp } = require('./auth/authService');
    const control = createControlPlane({ port: CONTROL_PORT });
    const authApp = createAuthApp();
    const authServer = require('http').createServer(authApp);
    authServer.listen(AUTH_PORT, () => console.log(`[auth] listening on :${AUTH_PORT}`));

    // Fork isolated worker processes.
    const workers = [];
    function fork(role, env) {
      const w = cluster.fork({ ROLE: role, ...env });
      workers.push(w);
    }
    fork('entrylb', { ENTRY_PORT: String(ENTRY_PORT) });
    GATEWAY_PORTS.forEach((p) => fork('gateway', { GW_PORT: String(p), CP_URL }));
    parseBackends().forEach(({ port, service }) => fork('backend', { BE_PORT: String(port), BE_SERVICE: service }));

    console.log(`EdgeGate started: entry-lb :${ENTRY_PORT}, gateways ${GATEWAY_PORTS.join(',')}, backends ${parseBackends().map((b) => b.port).join(',')}, control :${CONTROL_PORT}, auth :${AUTH_PORT}`);

    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down EdgeGate...');
      for (const w of workers) { try { w.process.kill(); } catch (_) {} }
      try { await control.close(); } catch (_) {}
      try { await new Promise((r) => authServer.close(r)); } catch (_) {}
      try { await disconnectDb(); } catch (_) {}
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })().catch((err) => {
    console.error('Failed to start EdgeGate:', err.message);
    console.error('Hint: run "npm run db:up" to start MongoDB and Redis via Docker first.');
    process.exit(1);
  });
} else {
  // Worker processes: run exactly one role.
  const role = process.env.ROLE;
  if (role === 'entrylb') {
    require('./gateway/entryLb').startEntryLb({
      port: Number(process.env.ENTRY_PORT),
      gatewayPorts: (process.env.GATEWAY_PORTS || '3011,3012,3013').split(',').map(Number),
    });
  } else if (role === 'gateway') {
    require('./gateway/gateway').startGateway({
      port: Number(process.env.GW_PORT),
      name: `gateway-${process.env.GW_PORT}`,
      cpUrl: process.env.CP_URL || CP_URL,
    });
  } else if (role === 'backend') {
    require('./services/microservice').startServiceInstance({
      port: Number(process.env.BE_PORT),
      service: process.env.BE_SERVICE,
    });
  } else {
    console.error('Unknown worker ROLE:', role);
    process.exit(1);
  }
}
