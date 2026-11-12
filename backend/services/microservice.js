/**
 * Backend microservice instance factory.
 *
 * Six instances run from this file (ports 4001-4006), two per service:
 *   users:    4001, 4004
 *   products: 4002, 4005
 *   orders:   4003, 4006
 *
 * Each instance is its own OS process (spawned by cluster in backend/index.js)
 * and exposes:
 *   GET  /health  - health + requestCount (polled by the control plane)
 *   GET  /        - service data
 *   POST /        - create data (echoes payload + instance identity)
 *
 * Failure simulation changes ACTUAL availability, not just a badge:
 *   down    -> /health returns 503 and data endpoints return 503
 *   latency -> adds delay to every response
 *   errors  -> returns 500 for ~30% of requests
 */
const express = require('express');

function createServiceApp({ port, service }) {
  const app = express();
  app.use(require('cors')());
  app.use(express.json({ limit: '256kb' }));

  const sim = { down: false, latencyMs: 0, errorRate: 0 };
  const metrics = { requests: 0, errors: 0, totalLatencyMs: 0 };

  function delay(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  function identify(res) {
    res.setHeader('x-service', service);
    res.setHeader('x-instance', String(port));
  }

  app.all('*', async (req, res) => {
    identify(res);

    // Health checks are monitoring traffic, not user API traffic:
    // never counted in metrics and never subject to the error simulation,
    // so the active health checker always sees the instance's REAL state.
    if (req.path === '/health') {
      if (sim.down) {
        return res.status(503).json({ error: 'service_unavailable', message: `${service} instance :${port} is simulated offline`, service, instance: port, timestamp: new Date().toISOString() });
      }
      return res.json({ status: 'up', service, instance: port, requestCount: metrics.requests, timestamp: new Date().toISOString() });
    }

    metrics.requests += 1;
    // Backend PROCESSING latency: request arrival -> response finished.
    // (Health checks are excluded above; gateway-level counters carry the
    // end-to-end latency including proxy time.)
    const started = Date.now();
    res.on('finish', () => { metrics.totalLatencyMs += Date.now() - started; });

    if (sim.down) {
      // Simulated failure = real unavailability for LB + health checks.
      metrics.errors += 1;
      return res.status(503).json({ error: 'service_unavailable', message: `${service} instance :${port} is simulated offline`, service, instance: port, timestamp: new Date().toISOString() });
    }

    await delay(sim.latencyMs);

    if (sim.errorRate > 0 && Math.random() < sim.errorRate) {
      metrics.errors += 1;
      return res.status(500).json({ error: 'simulated_error', service, instance: port, timestamp: new Date().toISOString() });
    }

    // Data endpoints (GET / POST) - the actual proxied targets.
    if (req.method === 'POST') {
      return res.status(201).json({
        message: `Created on ${service} instance :${port}`,
        service, instance: port,
        data: req.body || null,
        timestamp: new Date().toISOString(),
      });
    }
    // GET
    const sample = {
      users: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Alan' }],
      products: [{ id: 1, name: 'Keyboard', price: 49 }, { id: 2, name: 'Monitor', price: 199 }],
      orders: [{ id: 1, item: 'Keyboard', qty: 1 }, { id: 2, item: 'Monitor', qty: 2 }],
    };
    return res.json({
      message: `Hello from ${service} instance :${port}`,
      service, instance: port,
      data: sample[service] || [],
      timestamp: new Date().toISOString(),
    });
  });

  // Applied via Redis BACKEND_CMD from the control plane.
  app.applyCommand = (action, value) => {
    if (action === 'down') { sim.down = true; sim.latencyMs = 0; sim.errorRate = 0; }
    if (action === 'up') { sim.down = false; sim.latencyMs = 0; sim.errorRate = 0; }
    if (action === 'latency') sim.latencyMs = Number(value) || 0;
    if (action === 'errors') sim.errorRate = Math.min(Number(value) || 0, 1);
    if (action === 'reset') metrics.requests = 0, metrics.errors = 0, metrics.totalLatencyMs = 0;
    console.log(`[svc:${service}:${port}] applied ${action}${value != null ? ` (${value})` : ''}`);
  };

  app.getState = () => ({ down: sim.down, latencyMs: sim.latencyMs, errorRate: sim.errorRate, requests: metrics.requests, errors: metrics.errors, avgLatency: metrics.requests ? Math.round(metrics.totalLatencyMs / metrics.requests) : 0 });

  return app;
}

async function startServiceInstance({ port, service }) {
  const http = require('http');
  const { createSubscriber, createRedis, CHANNELS } = require('../redis');
  const app = createServiceApp({ port, service });
  const server = http.createServer(app);

  const sub = createSubscriber();
  sub.subscribe(CHANNELS.BACKEND_CMD, CHANNELS.RESET);
  sub.on('message', (channel, message) => {
    try {
      const msg = JSON.parse(message);
      if (channel === CHANNELS.BACKEND_CMD && Number(msg.port) === Number(port)) {
        app.applyCommand(msg.action, msg.value);
      } else if (channel === CHANNELS.RESET) {
        app.applyCommand('reset');
      }
    } catch (_) { /* ignore */ }
  });

  const publisher = createRedis();
  // Heartbeat with real request count so the control plane shows live stats.
  const beat = setInterval(() => {
    const s = app.getState();
    publisher.publish(CHANNELS.METRICS, JSON.stringify({ source: `${service}-${port}`, kind: 'backend', service, port, ...s, healthy: !s.down, ts: Date.now() }));
  }, 1000);

  server.listen(port, () => console.log(`[svc:${service}] instance :${port} listening`));

  async function close() {
    clearInterval(beat);
    await new Promise((r) => server.close(r));
    sub.quit(); publisher.quit();
  }
  return { server, close };
}

module.exports = { createServiceApp, startServiceInstance };
