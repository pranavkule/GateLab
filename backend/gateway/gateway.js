/**
 * Gateway instance (Layer 7).
 *
 * Request path:
 *   receive -> match routing rule (in-memory table) -> JWT middleware
 *   -> pick healthy backend instance (round-robin) -> reverse proxy
 *   -> record metrics + async log record (Redis -> control plane -> MongoDB)
 *
 * Runtime sync (all via Redis Pub/Sub, no restarts needed):
 *   CONFIG        - full routing snapshot -> atomic table replacement
 *   BACKEND_CMD   - fail/recover commands (health awareness)
 *   GATEWAY_CMD   - this gateway's own fail/recover simulation
 *   RESET         - clear counters
 */
const express = require('express');
const http = require('http');
const { forward } = require('../proxy');
const { jwtAuthMiddleware } = require('../middleware/jwtAuth');
const { createRateLimitMiddleware } = require('../middleware/rateLimit');
const { createRoundRobin } = require('../loadBalancer/roundRobin');
const registry = require('../registry');
const { CHANNELS, createSubscriber, createRedis } = require('../redis');
const { backendInstances } = require('../config');
const { corsMiddleware } = require('../security/cors');

function matchRoute(routes, path) {
  // '/api/users/*' matches '/api/users' and '/api/users/42'
  for (const r of routes) {
    if (r.enabled === false) continue;
    const base = r.path.replace(/\/\*$/, '');
    if (path === base || path.startsWith(base + '/')) return r;
  }
  return null;
}

function createGatewayApp({ name, publishFn, rateLimitRedis }) {
  const gwState = { selfDown: false }; // simulated gateway failure flag

  const app = express();
  app.use(corsMiddleware());
  const serviceInstances = backendInstances();
  const rr = createRoundRobin();

  // Universal request logger: publishes exactly one log record per /api
  // request when the response finishes (covers 401s, 404s, 429s and 503s that
  // short-circuit before the proxy). The proxy handler marks the record as
  // already published via res.locals.logged.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.locals = res.locals || {};
      res.locals.logged = false;
      const started = Date.now();
      res.on('finish', () => {
        if (res.locals.logged) return;
        res.locals.logged = true;
        publishLog({
          method: req.method, path: req.path,
          backendService: res.locals.backendService || (matchRoute(registry.state.routes, req.path) || {}).targetService || 'none',
          backendInstance: res.locals.backendInstance || 'none',
          jwtStatus: req.jwtStatus || 'none',
          status: res.statusCode, latencyMs: Date.now() - started,
          ...(res.locals.rateLimited ? { rateLimited: true } : {}),
        });
      });
    }
    next();
  });

  // JWT middleware resolves the route from this process's local routing table.
  app.use(jwtAuthMiddleware((path) => matchRoute(registry.state.routes, path)));

  // Shared fixed-window rate limiting (Redis counters across all gateways).
  // Mounted after JWT: missing/invalid JWTs keep their existing 401, and
  // authenticated identities are preferred over IPs. Routes without a
  // rateLimit configuration pass straight through.
  if (rateLimitRedis) {
    app.use(createRateLimitMiddleware({
      getRouteForPath: (path) => matchRoute(registry.state.routes, path),
      redis: rateLimitRedis,
      gatewayName: name,
    }));
  }

  // Self health - polled by the entry LB and the control plane.
  app.get('/gateway-health', (req, res) => {
    if (gwState.selfDown) return res.status(503).json({ status: 'down', simulated: true });
    res.json({ status: 'up', gateway: name, metrics: registry.state.metrics, configVersion: registry.state.configVersion });
  });
  app.get('/health', (req, res) => {
    if (gwState.selfDown) return res.status(503).json({ status: 'down', simulated: true });
    res.json({ status: 'up', gateway: name });
  });

  function publishLog(record) {
    if (!publishFn) return;
    publishFn(CHANNELS.LOGS, JSON.stringify({ timestamp: new Date().toISOString(), gateway: name, ...record }));
  }

  // Dynamic L7 routing: every /api/* request flows through the routing table.
  app.all('/api/*', async (req, res, next) => {
    const started = Date.now();

    if (gwState.selfDown) {
      // Simulated failure: behave like an unresponsive process for real traffic.
      res.status(503).json({ error: 'service_unavailable', message: `Gateway ${name} is simulated offline` });
      return;
    }

    const route = matchRoute(registry.state.routes, req.path);
    res.setHeader('x-gateway', name);
    if (!route) {
      res.status(404).json({ error: 'route_not_found', message: `No routing rule matches ${req.path}` });
      return;
    }

    const instances = serviceInstances[route.targetService] || [];
    const healthy = registry.healthyBackends(route.targetService, instances);
    if (healthy.length === 0) {
      res.status(503).json({ error: 'service_unavailable', message: `All instances of ${route.targetService} are unhealthy` });
      return;
    }

    // Try up to 2 candidates so a just-failed instance is skipped immediately.
    for (let attempt = 0; attempt < Math.min(2, healthy.length); attempt++) {
      const instance = rr.next(route.targetService, healthy);
      if (instance == null) break;
      try {
        res.locals.backendService = route.targetService;
        res.locals.backendInstance = String(instance);
        res.locals.logged = true; // proxy path publishes its own record below
        await forward(req, res, `http://127.0.0.1:${instance}`, 8000);
        const latency = Date.now() - started;
        registry.trackRequest(latency, res.statusCode, req.jwtStatus);
        publishLog({
          method: req.method, path: req.path,
          backendService: route.targetService, backendInstance: String(instance),
          jwtStatus: req.jwtStatus, status: res.statusCode, latencyMs: latency,
        });
        return;
      } catch (err) {
        if (res.headersSent) return;
        // Passive health: open the circuit locally; active checks will confirm recovery.
        registry.markBackendFailure(instance);
        res.locals.logged = true; // already published below
        publishLog({
          method: req.method, path: req.path,
          backendService: route.targetService, backendInstance: String(instance),
          jwtStatus: req.jwtStatus, status: 502, latencyMs: Date.now() - started, error: 'upstream_error',
        });
      }
    }
    if (!res.headersSent) {
      registry.trackRequest(Date.now() - started, 502, req.jwtStatus);
      res.status(502).json({ error: 'bad_gateway', message: 'Backend instance(s) unreachable' });
    }
  });

  return { app, gwState };
}

/**
 * Boots one gateway as its own OS process.
 */
async function startGateway({ port, name, cpUrl }) {
  const publisher = createRedis();
  const sub = createSubscriber();
  // Persistent dedicated connection for shared rate-limit counters: one per
  // gateway process, never per request.
  const rateLimitRedis = createRedis();
  const { createGatewayApp } = require('./gateway');
  const { app, gwState } = createGatewayApp({ name, publishFn: (ch, msg) => publisher.publish(ch, msg), rateLimitRedis });

  const server = http.createServer(app);

  // --- initial sync: fetch latest config from the control plane ---
  async function syncConfig() {
    try {
      const res = await fetch(`${cpUrl}/api/config/latest`);
      if (res.ok) {
        const cfg = await res.json();
        registry.replaceRoutes(cfg.routes, cfg.version);
        console.log(`[${name}] synced config v${cfg.version} (${cfg.routes.length} routes)`);
        return true;
      }
    } catch (_) { /* control plane not ready yet - retry below */ }
    return false;
  }
  await syncConfig();
  const retry = setInterval(async () => {
    if (await syncConfig()) clearInterval(retry);
  }, 2000);

  // --- subscriptions ---
  sub.subscribe(CHANNELS.CONFIG, CHANNELS.BACKEND_CMD, CHANNELS.GATEWAY_CMD, CHANNELS.RESET);
  sub.on('message', (channel, message) => {
    try {
      const msg = JSON.parse(message);
      if (channel === CHANNELS.CONFIG) {
        // Atomic replacement: in-flight requests keep the old table reference.
        registry.replaceRoutes(msg.routes, msg.version);
        console.log(`[${name}] config reloaded -> v${msg.version} (no restart)`);
      } else if (channel === CHANNELS.BACKEND_CMD) {
        if (msg.action === 'down') registry.setBackendHealth(msg.port, false);
        if (msg.action === 'up') registry.setBackendHealth(msg.port, true);
      } else if (channel === CHANNELS.GATEWAY_CMD && Number(msg.port) === Number(port)) {
        gwState.selfDown = msg.action === 'down';
        console.log(`[${name}] ${gwState.selfDown ? 'simulated OFFLINE' : 'recovered'}`);
      } else if (channel === CHANNELS.RESET) {
        registry.resetMetrics();
      }
    } catch (e) { console.error(`[${name}] pubsub error: ${e.message}`); }
  });

  // --- periodic real metrics snapshot -> control plane ---
  let lastRequests = 0;
  const metricsTimer = setInterval(() => {
    const m = registry.state.metrics;
    const rps = Math.max(0, m.requests - lastRequests);
    lastRequests = m.requests;
    publisher.publish(CHANNELS.METRICS, JSON.stringify({
      source: name, kind: 'gateway',
      requests: m.requests, success: m.success, failed: m.failed, unauthorized: m.unauthorized,
      rateLimited: m.rateLimited,
      avgLatency: m.requests ? Math.round(m.totalLatencyMs / m.requests) : 0,
      rps, configVersion: registry.state.configVersion, healthy: !gwState.selfDown, ts: Date.now(),
    }));
  }, 1000);

  server.listen(port, '127.0.0.1', () => console.log(`[${name}] listening on 127.0.0.1:${port}`));

  async function close() {
    clearInterval(metricsTimer);
    clearInterval(retry);
    await new Promise((r) => server.close(r));
    sub.quit(); publisher.quit(); rateLimitRedis.quit();
  }
  return { server, close };
}

module.exports = { createGatewayApp, startGateway, matchRoute };
