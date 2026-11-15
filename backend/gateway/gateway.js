/**
 * Gateway instance (Layer 7).
 *
 * Request path:
 *   receive -> match routing rule (in-memory table) -> JWT middleware
 *   -> shared rate limit -> pick eligible backend instance
 *   (not admin-hard-down, circuit CLOSED/HALF-OPEN, round-robin)
 *   -> reverse proxy -> classify outcome into the shared Redis circuit
 *   -> record metrics + async log record (Redis -> control plane -> MongoDB)
 *
 * Runtime sync (all via Redis Pub/Sub, no restarts needed):
 *   CONFIG        - full routing snapshot -> atomic table replacement
 *   BACKEND_CMD   - fail/recover commands (hard-down state + circuit reset)
 *   GATEWAY_CMD   - this gateway's own fail/recover simulation
 *   RESET         - clear counters + circuit state
 */
const express = require('express');
const http = require('http');
const { forward, destroyAgent } = require('../proxy');
const { jwtAuthMiddleware } = require('../middleware/jwtAuth');
const { createRateLimitMiddleware } = require('../middleware/rateLimit');
const { createCircuitBreaker } = require('../circuitBreaker');
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

// Fail-open stub used only when no circuit breaker is supplied (defensive
// default for embedders): everything is eligible and outcomes are ignored.
function failOpenCircuitBreaker(name) {
  return {
    filterEligible: async (ports) => ({ eligible: [...(ports || [])], blocked: [] }),
    admit: async () => ({ allowed: true, state: 'closed', retryAfterMs: 0 }),
    recordSuccess: async () => ({ level: 0, state: 'closed', retryAfterMs: 0 }),
    recordFailure: async () => ({ level: 0, state: 'closed', retryAfterMs: 0 }),
    status: async (port) => ({ port: Number(port), state: 'closed', storedState: 'closed', failures: 0, probes: 0, retryAfterMs: 0 }),
    statusAll: async (ports) => {
      const map = {};
      for (const p of ports || []) map[Number(p)] = { port: Number(p), state: 'closed', storedState: 'closed', failures: 0, probes: 0, retryAfterMs: 0 };
      return map;
    },
    reset: async () => true,
    resetAll: async () => 0,
  };
}

function createGatewayApp({ name, publishFn, rateLimitRedis, circuitBreaker }) {
  const gwState = { selfDown: false }; // simulated gateway failure flag
  const cb = circuitBreaker || failOpenCircuitBreaker(name);

  const app = express();
  app.use(corsMiddleware());
  const serviceInstances = backendInstances();
  const allBackendPorts = [...new Set(Object.values(serviceInstances).flat())];
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

  // Self health - polled by the entry LB and the control plane. Includes
  // the Redis-backed circuit states for monitoring (P2.5.1).
  app.get('/gateway-health', async (req, res) => {
    if (gwState.selfDown) return res.status(503).json({ status: 'down', simulated: true });
    const circuits = await cb.statusAll(allBackendPorts);
    res.json({ status: 'up', gateway: name, metrics: registry.state.metrics, configVersion: registry.state.configVersion, circuits });
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
    // Availability model (kept separate by design):
    //   hardDown     - administrative Fail command (BACKEND_CMD)
    //   circuit open - Redis-backed circuit breaker (P2.5.1)
    // Active health checks never change either state.
    const available = registry.healthyBackends(route.targetService, instances);
    if (available.length === 0) {
      registry.trackRequest(Date.now() - started, 503, req.jwtStatus);
      res.status(503).json({ error: 'service_unavailable', message: `All instances of ${route.targetService} are unhealthy` });
      return;
    }

    // Filter out circuit-OPEN instances BEFORE round-robin selection, so
    // blocked candidates never advance the round-robin cursor and HALF-OPEN
    // probe slots are never consumed for candidates that will not actually
    // receive a request. Fail-open keeps every candidate when Redis is down.
    const { eligible, blocked } = await cb.filterEligible(available);
    if (eligible.length === 0) {
      // Every available instance is circuit-blocked: clean 503 (never
      // counted as a backend failure anywhere).
      const retryMs = blocked.reduce((min, b) => (b.retryAfterMs > 0 && (min === 0 || b.retryAfterMs < min) ? b.retryAfterMs : min), 0);
      const retrySeconds = retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : 1;
      registry.trackRequest(Date.now() - started, 503, req.jwtStatus);
      // Header lets the entry LB distinguish a backend-circuit 503 from a
      // genuine gateway failure (the body may already be streamed away).
      res.set('x-edgegate-circuit', 'open');
      res.set('Retry-After', String(retrySeconds));
      res.status(503).json({
        error: 'circuit_open',
        message: `Circuit breaker is open for ${route.targetService} backend instance(s)`,
        retryAfterMs: retryMs,
      });
      return;
    }

    // Try up to 2 candidates so a just-failed instance is skipped immediately.
    let circuitDenied = false; // lost a HALF-OPEN probe race
    let attempted = false;     // actually forwarded at least once
    for (let attempt = 0; attempt < Math.min(2, eligible.length); attempt++) {
      const instance = rr.next(route.targetService, eligible);
      if (instance == null) break;
      // Reserve BEFORE forwarding: performs the lazy OPEN -> HALF-OPEN
      // transition and atomically consumes one probe slot if half-open.
      const admission = await cb.admit(instance);
      if (!admission.allowed) { circuitDenied = true; continue; }
      attempted = true;
      try {
        res.locals.backendService = route.targetService;
        res.locals.backendInstance = String(instance);
        res.locals.logged = true; // proxy path publishes its own record below
        await forward(req, res, `http://127.0.0.1:${instance}`, 8000);
        const latency = Date.now() - started;
        // Failure classification (P2.5.1): upstream 5xx and proxy errors
        // (unreachable/timeout) are failures; 2xx/3xx/4xx are successes.
        // Gateway-generated answers (429, 401, 404, 503...) never reach a
        // record call at all.
        if (res.statusCode >= 500) await cb.recordFailure(instance);
        else await cb.recordSuccess(instance);
        registry.trackRequest(latency, res.statusCode, req.jwtStatus);
        publishLog({
          method: req.method, path: req.path,
          backendService: route.targetService, backendInstance: String(instance),
          jwtStatus: req.jwtStatus, status: res.statusCode, latencyMs: latency,
        });
        return;
      } catch (err) {
        if (res.headersSent) return;
        // Connection refused / unreachable / upstream timeout: record the
        // failure in the shared circuit. Local registry availability is NOT
        // touched, so HALF-OPEN probes stay possible after the cooldown.
        await cb.recordFailure(instance);
        res.locals.logged = true; // already published below
        publishLog({
          method: req.method, path: req.path,
          backendService: route.targetService, backendInstance: String(instance),
          jwtStatus: req.jwtStatus, status: 502, latencyMs: Date.now() - started, error: 'upstream_error',
        });
      }
    }
    if (!res.headersSent) {
      if (circuitDenied && !attempted) {
        // Every candidate was denied at admission (probe slots taken by the
        // other gateways between filtering and forwarding).
        registry.trackRequest(Date.now() - started, 503, req.jwtStatus);
        res.set('x-edgegate-circuit', 'open');
        res.set('Retry-After', '1');
        res.status(503).json({
          error: 'circuit_open',
          message: `Circuit breaker is open for ${route.targetService} backend instance(s)`,
          retryAfterMs: 1000,
        });
        return;
      }
      registry.trackRequest(Date.now() - started, 502, req.jwtStatus);
      res.status(502).json({ error: 'bad_gateway', message: 'Backend instance(s) unreachable' });
    }
  });

  return { app, gwState, cb, allBackendPorts };
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
  // Persistent dedicated connection for the shared circuit-breaker state.
  const cbRedis = createRedis();
  const circuitBreaker = createCircuitBreaker({ redis: cbRedis, name });
  const { createGatewayApp } = require('./gateway');
  const { app, gwState, cb, allBackendPorts } = createGatewayApp({ name, publishFn: (ch, msg) => publisher.publish(ch, msg), rateLimitRedis, circuitBreaker });

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
        if (msg.action === 'down') {
          // Administrative hard-down: exclude the instance locally.
          registry.setBackendHealth(msg.port, false);
        }
        if (msg.action === 'up') {
          // Manual Recover: restore the instance AND reset its circuit so a
          // previously OPEN breaker cannot block the freshly recovered
          // backend behind an old cooldown.
          registry.setBackendHealth(msg.port, true);
          cb.reset(msg.port);
        }
      } else if (channel === CHANNELS.GATEWAY_CMD && Number(msg.port) === Number(port)) {
        gwState.selfDown = msg.action === 'down';
        console.log(`[${name}] ${gwState.selfDown ? 'simulated OFFLINE' : 'recovered'}`);
      } else if (channel === CHANNELS.RESET) {
        registry.resetMetrics();
        cb.resetAll();
      }
    } catch (e) { console.error(`[${name}] pubsub error: ${e.message}`); }
  });

  // --- periodic real metrics snapshot -> control plane ---
  let lastRequests = 0;
  const metricsTimer = setInterval(async () => {
    const m = registry.state.metrics;
    const rps = Math.max(0, m.requests - lastRequests);
    lastRequests = m.requests;
    const circuits = await cb.statusAll(allBackendPorts);
    publisher.publish(CHANNELS.METRICS, JSON.stringify({
      source: name, kind: 'gateway',
      requests: m.requests, success: m.success, failed: m.failed, unauthorized: m.unauthorized,
      rateLimited: m.rateLimited,
      avgLatency: m.requests ? Math.round(m.totalLatencyMs / m.requests) : 0,
      rps, configVersion: registry.state.configVersion, circuits, healthy: !gwState.selfDown, ts: Date.now(),
    }));
  }, 1000);

  server.listen(port, '127.0.0.1', () => console.log(`[${name}] listening on 127.0.0.1:${port}`));

  async function close() {
    clearInterval(metricsTimer);
    clearInterval(retry);
    await new Promise((r) => server.close(r));
    destroyAgent();
    await Promise.all([sub.quit(), publisher.quit(), rateLimitRedis.quit(), cbRedis.quit()]);
  }
  return { server, close };
}

module.exports = { createGatewayApp, startGateway, matchRoute };
