/**
 * Control plane (:5000) - REST API + Socket.IO live monitoring.
 *
 * This is the only process that touches MongoDB for runtime data:
 *  - persists request logs (received in batches over Redis, never blocking
 *    the gateway request path)
 *  - stores versioned routing configs + audit history
 *  - broadcasts real metrics/health/log updates to the dashboard
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RouteConfig, ConfigAudit, RequestLog } = require('./models');
const manager = require('./config/manager');
const { CHANNELS, createSubscriber, createRedis } = require('./redis');
const { SERVICE_META, backendInstances } = require('./config');
const { startHealthChecker } = require('./health/checker');
const { signToken } = require('./auth/jwt');
const registry = require('./registry');

function createControlPlane({ port }) {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  // Simple CORS for the Vite dev server.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  const publisher = createRedis();

  // Load the active configuration into the control plane's own registry so
  // /api/status reports the right version even before any new Apply.
  manager.getLatest().then((latest) => {
    if (latest) registry.replaceRoutes(latest.routes, latest.version);
  }).catch(() => {});

  // Latest metric snapshots from all sources (real values pushed by processes).
  const metricSources = new Map(); // source -> snapshot
  const history = [];              // last 60 seconds of {ts, rps, avgLatency}

  // ---------- Redis consumers ----------
  const sub = createSubscriber();
  sub.subscribe(CHANNELS.LOGS, CHANNELS.METRICS, CHANNELS.CONFIG);

  // Request logs arrive here from gateways; batch-insert to MongoDB every
  // second so per-request DB writes never sit in the request lifecycle.
  const logBuffer = [];
  const logFlush = setInterval(async () => {
    if (logBuffer.length === 0) return;
    const batch = logBuffer.splice(0, logBuffer.length);
    try {
      const docs = await RequestLog.insertMany(batch);
      io.emit('request-log', docs);
    } catch (e) { console.error('[control] log flush failed:', e.message); }
  }, 1000);

  sub.on('message', (channel, message) => {
    try {
      if (channel === CHANNELS.LOGS) {
        logBuffer.push(JSON.parse(message));
      } else if (channel === CHANNELS.METRICS) {
        const snap = JSON.parse(message);
        metricSources.set(snap.source, snap);
      } else if (channel === CHANNELS.CONFIG) {
        // Also notify any UI listening (config applied by another path).
        io.emit('config-update', JSON.parse(message));
      }
    } catch (_) { /* ignore malformed */ }
  });

  // ---------- metrics aggregation (every second) ----------
  setInterval(() => {
    const entry = metricSources.get('entry-lb') || {};
    const gateways = [...metricSources.values()].filter((s) => s.kind === 'gateway');
    const backends = [...metricSources.values()].filter((s) => s.kind === 'backend');

    const overview = {
      totalRequests: entry.requests || 0,
      success: entry.success || 0,
      unauthorized: entry.unauthorized || 0,
      failed: entry.failed || 0,
      avgLatency: entry.avgLatency || 0,
      throughputRps: entry.rps || 0,
      ts: Date.now(),
    };
    if (history.length === 0 || Date.now() - history[history.length - 1].ts >= 1000) {
      history.push({ ts: overview.ts, rps: overview.throughputRps, latency: overview.avgLatency });
      if (history.length > 60) history.shift();
    }
    io.emit('metrics', {
      overview, history: [...history],
      gateways: gateways.map((g) => ({ ...g })),
      backends: backends.map((b) => ({ ...b })),
    });
  }, 1000);

  // ---------- health checker ----------
  const bi = backendInstances();
  const gwPorts = (process.env.GATEWAY_PORTS || '3001,3002,3003').split(',').map(Number);
  const health = startHealthChecker({
    backendPorts: bi, gatewayPorts: gwPorts,
    intervalMs: Number(process.env.HEALTH_CHECK_INTERVAL) || 3000,
    onChange: (event, snapshot) => io.emit(event, snapshot),
  });

  // ---------- REST: configuration ----------
  app.get('/api/config/latest', async (req, res, next) => {
    try {
      const latest = await manager.getLatest();
      res.json(latest ? { version: latest.version, routes: latest.routes, appliedAt: latest.appliedAt } : { version: 0, routes: [] });
    } catch (e) { next(e); }
  });

  app.put('/api/config', async (req, res, next) => {
    try {
      const { routes } = req.body || {};
      const applied = await manager.applyRoutes(routes, 'dashboard');
      res.json(applied);
    } catch (e) { next(e); }
  });

  app.get('/api/config/history', async (req, res, next) => {
    try {
      const versions = await RouteConfig.find().sort({ version: -1 }).limit(20).lean();
      const audit = await ConfigAudit.find().sort({ createdAt: -1 }).limit(20).lean();
      res.json({ versions, audit });
    } catch (e) { next(e); }
  });

  // ---------- REST: status / instances ----------
  app.get('/api/status', (req, res) => {
    res.json({
      configVersion: registry.state.configVersion,
      gateways: health.gatewayHealth,
      backends: health.backendHealth,
      services: SERVICE_META,
      instances: bi,
    });
  });

  // ---------- REST: failure simulation (changes REAL availability) ----------
  function publishCmd(channel, payload) {
    return publisher.publish(channel, JSON.stringify(payload));
  }

  app.post('/api/backend/:port/:action', async (req, res) => {
    const port = Number(req.params.port);
    const action = req.params.action; // fail | recover | latency | errors
    const valid = { fail: ['down'], recover: ['up'], latency: ['latency'], errors: ['errors'] };
    if (!valid[action]) return res.status(400).json({ error: 'bad_request', message: 'action must be fail|recover|latency|errors' });
    const cmd = action === 'fail' ? 'down' : action === 'recover' ? 'up' : action;
    const value = action === 'latency' ? (req.body.ms || 400) : action === 'errors' ? (req.body.rate || 0.3) : undefined;
    await publishCmd(CHANNELS.BACKEND_CMD, { port, action: cmd, value });
    // Gateways exclude the instance immediately for consistent LB behavior.
    if (cmd === 'down') await publishCmd(CHANNELS.BACKEND_CMD, { port, action: 'down' });
    res.json({ ok: true, port, action: cmd, value });
  });

  app.post('/api/gateway/:port/:action', async (req, res) => {
    const port = Number(req.params.port);
    const action = req.params.action;
    if (!['fail', 'recover'].includes(action)) return res.status(400).json({ error: 'bad_request', message: 'action must be fail|recover' });
    await publishCmd(CHANNELS.GATEWAY_CMD, { port, action: action === 'fail' ? 'down' : 'up' });
    res.json({ ok: true, port, action });
  });

  // ---------- REST: request logs ----------
  app.get('/api/logs', async (req, res, next) => {
    try {
      const { search = '', status = '', page = 1, limit = 25 } = req.query;
      const q = {};
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        q.$or = [{ path: rx }, { method: rx }, { gateway: rx }, { backendService: rx }];
      }
      if (status === 'success') q.status = { $lt: 400 };
      else if (status === 'unauthorized') q.status = 401;
      else if (status === 'failed') q.status = { $gte: 500 };
      else if (status) q.status = Number(status);
      const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
      const [docs, total] = await Promise.all([
        RequestLog.find(q).sort({ timestamp: -1 }).skip(skip).limit(Number(limit)).lean(),
        RequestLog.countDocuments(q),
      ]);
      res.json({ logs: docs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
    } catch (e) { next(e); }
  });

  app.delete('/api/logs', async (req, res, next) => {
    try {
      await RequestLog.deleteMany({});
      io.emit('logs-cleared');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- REST: reset lab (counters only, config history is kept) ----------
  app.post('/api/reset', async (req, res, next) => {
    try {
      await publishCmd(CHANNELS.RESET, { ts: Date.now() });
      await RequestLog.deleteMany({});
      Object.keys(metricSources).length && metricSources.clear();
      history.length = 0;
      io.emit('logs-cleared');
      res.json({ ok: true, message: 'Lab counters and request logs cleared (configuration history preserved)' });
    } catch (e) { next(e); }
  });

  // ---------- REST: demo JWT tokens (never expose the secret) ----------
  app.get('/api/demo-token', (req, res) => {
    const type = req.query.type || 'valid';
    if (type === 'valid') return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }) });
    if (type === 'expired') return res.json({ token: signToken({ sub: 'demo-student', role: 'student' }, { expiresIn: '-10s' }) });
    if (type === 'invalid') return res.json({ token: 'this.is.not.a.valid.jwt' });
    res.status(400).json({ error: 'bad_request' });
  });

  // Error handler - clean JSON, no stack traces.
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'internal_error', message: err.status ? undefined : 'Unexpected control plane error' });
  });

  server.listen(port, () => console.log(`[control-plane] REST + Socket.IO on :${port}`));

  async function close() {
    clearInterval(logFlush);
    health.close();
    await new Promise((r) => server.close(r));
    io.close(); sub.quit(); publisher.quit();
  }
  return { server, io, close };
}

module.exports = { createControlPlane };
