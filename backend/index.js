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
    const { createRedis } = require('./redis');
    const manager = require('./config/manager');
    await connectDb();
    await manager.seedIfEmpty();

    // Control plane + auth live in the primary process.
    const { createControlPlane } = require('./controlPlane');
    const { createAuthApp } = require('./auth/authService');
    const control = createControlPlane({ port: CONTROL_PORT });
    const authRedis = createRedis();
    const authApp = createAuthApp({ redis: authRedis });
    const authServer = require('http').createServer(authApp);
    authServer.listen(AUTH_PORT, () => console.log(`[auth] listening on :${AUTH_PORT}`));

    // Fork isolated worker processes with auto-respawn supervision (P2.6.1):
    // per-worker restart budget + backoff, no respawn during shutdown.
    const { createSupervisor } = require('./cluster/supervisor');
    const supervisor = createSupervisor({
      fork: (spec) => cluster.fork({ ROLE: spec.role, ...spec.env }),
      specs: [
        { label: 'entrylb', role: 'entrylb', env: { ENTRY_PORT: String(ENTRY_PORT) } },
        ...GATEWAY_PORTS.map((p) => ({ label: `gateway-${p}`, role: 'gateway', env: { GW_PORT: String(p), CP_URL } })),
        ...parseBackends().map(({ port, service }) => ({ label: `backend-${port}`, role: 'backend', env: { BE_PORT: String(port), BE_SERVICE: service } })),
      ],
      respawn: process.env.WORKER_RESPAWN !== 'false',
      maxRestarts: Number(process.env.WORKER_MAX_RESTARTS) || 5,
      windowMs: Number(process.env.WORKER_RESTART_WINDOW_MS) || 60000,
      backoffMs: Number(process.env.WORKER_RESTART_BACKOFF_MS) || 1000,
    });
    supervisor.start();

    console.log(`EdgeGate started: entry-lb :${ENTRY_PORT}, gateways ${GATEWAY_PORTS.join(',')}, backends ${parseBackends().map((b) => b.port).join(',')}, control :${CONTROL_PORT}, auth :${AUTH_PORT}`);

    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down EdgeGate...');
      let failed = false;
      // Stop the active health checker BEFORE the workers so its keep-alive
      // probes no longer hold open connections that block server.close()
      // inside the workers during their graceful drain.
      try { control.stopHealthChecker(); } catch (err) {
        failed = true;
        console.error(`[shutdown] health-checker cleanup failed: ${err.message}`);
      }
      try { await supervisor.shutdown(); } catch (err) {
        failed = true;
        console.error(`[shutdown] worker cleanup failed: ${err.message}`);
      }
      try { await control.close(); } catch (err) {
        failed = true;
        console.error(`[shutdown] control-plane cleanup failed: ${err.message}`);
      }
      try {
        await new Promise((resolve, reject) => authServer.close((err) => err ? reject(err) : resolve()));
      } catch (err) {
        failed = true;
        console.error(`[shutdown] auth-server cleanup failed: ${err.message}`);
      }
      try { await authRedis.quit(); } catch (err) {
        failed = true;
        console.error(`[shutdown] auth Redis cleanup failed: ${err.message}`);
      }
      try { await disconnectDb(); } catch (err) {
        failed = true;
        console.error(`[shutdown] MongoDB cleanup failed: ${err.message}`);
      }
      process.exit(failed ? 1 : 0);
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
  (async () => {
    let runtime;
    if (role === 'entrylb') {
      runtime = await require('./gateway/entryLb').startEntryLb({
        port: Number(process.env.ENTRY_PORT),
        gatewayPorts: (process.env.GATEWAY_PORTS || '3011,3012,3013').split(',').map(Number),
      });
    } else if (role === 'gateway') {
      runtime = await require('./gateway/gateway').startGateway({
        port: Number(process.env.GW_PORT),
        name: `gateway-${process.env.GW_PORT}`,
        cpUrl: process.env.CP_URL || CP_URL,
      });
    } else if (role === 'backend') {
      runtime = await require('./services/microservice').startServiceInstance({
        port: Number(process.env.BE_PORT),
        service: process.env.BE_SERVICE,
      });
    } else {
      throw new Error(`Unknown worker ROLE: ${role}`);
    }

    if (!runtime || typeof runtime.close !== 'function') {
      throw new Error(`Worker ${role} did not provide a shutdown handler`);
    }

    let closing = false;
    async function shutdown(signal) {
      if (closing) return;
      closing = true;
      console.log(`[worker:${role}] received ${signal}; shutting down`);
      try {
        await runtime.close();
      } catch (err) {
        console.error(`[worker:${role}] shutdown failed: ${err.message}`);
        process.exitCode = 1;
      }
      // The cluster IPC channel keeps the worker's event loop alive even
      // after every runtime handle is closed; disconnecting lets the process
      // exit naturally once the drain above completed (supervisor still
      // SIGKILLs if any handle was missed, so a stuck worker never hangs
      // the shutdown).
      if (process.channel) {
        try { process.disconnect(); } catch (_) { /* already disconnected */ }
      }
    }
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  })().catch((err) => {
    console.error(`[worker:${role || 'unknown'}] startup failed: ${err.message}`);
    process.exit(1);
  });
}
