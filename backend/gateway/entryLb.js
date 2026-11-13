/**
 * Entry-point load balancer (:3000).
 *
 * Distributes incoming traffic across the healthy gateway instances
 * (round-robin). Completely separate from the backend-service load
 * balancing done inside each gateway.
 *
 * Health model:
 *   - active:  polls /gateway-health on every instance every few seconds
 *   - passive: marks a gateway unhealthy after 2 consecutive forwarding errors
 *   - instant: Redis GATEWAY_CMD events exclude a simulated-offline gateway
 */
const http = require('http');
const { forward } = require('../proxy');
const registry = require('../registry');
const { CHANNELS, createSubscriber, createRedis } = require('../redis');
const { getCorsHeaders } = require('../security/cors');
const { normalizeClientIp } = require('../middleware/rateLimit');

async function startEntryLb({ port, gatewayPorts, healthIntervalMs }) {
  const publisher = createRedis();
  const sub = createSubscriber();
  const rr = require('../loadBalancer/roundRobin').createRoundRobin();
  const distribution = {}; // gatewayPort -> request count (real measurement)

  sub.subscribe(CHANNELS.GATEWAY_CMD, CHANNELS.RESET);
  sub.on('message', (channel, message) => {
    try {
      const msg = JSON.parse(message);
      if (channel === CHANNELS.GATEWAY_CMD) {
        // Trust the command instantly - faster than waiting for the poller.
        registry.setGatewayHealth(Number(msg.port), msg.action !== 'down');
      } else if (channel === CHANNELS.RESET) {
        Object.keys(distribution).forEach((k) => delete distribution[k]);
        registry.resetMetrics();
      }
    } catch (_) { /* ignore */ }
  });

  // Active health checks (also recovers gateways after passive failure).
  const checker = setInterval(async () => {
    for (const gp of gatewayPorts) {
      try {
        const res = await fetch(`http://127.0.0.1:${gp}/gateway-health`, { signal: AbortSignal.timeout(1500) });
        registry.setGatewayHealth(gp, res.ok);
      } catch (_) {
        registry.setGatewayHealth(gp, false);
      }
    }
  }, healthIntervalMs || Number(process.env.HEALTH_CHECK_INTERVAL) || 3000);

  const server = http.createServer(async (req, res) => {
    const corsHeaders = getCorsHeaders(req.headers.origin);
    if (corsHeaders === null) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin_not_allowed' }));
      return;
    }
    Object.entries(corsHeaders).forEach(([name, value]) => res.setHeader(name, value));
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const started = Date.now();
    const healthy = registry.healthyGateways(gatewayPorts);

    if (healthy.length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service_unavailable', message: 'No healthy gateway instances available' }));
      return;
    }

    const target = rr.next('gateways', healthy);
    distribution[target] = (distribution[target] || 0) + 1;
    // Trusted client IP for the gateway rate limiter: OVERWRITE (never append
    // to) X-Forwarded-For so clients cannot forge identity headers. Direct
    // gateway clients are loopback-only and not publicly reachable.
    req.headers['x-forwarded-for'] = normalizeClientIp(req.socket.remoteAddress);
    try {
      await forward(req, res, `http://127.0.0.1:${target}`, 10000);
      const latency = Date.now() - started;
      registry.trackRequest(latency, res.statusCode, 'none', res.statusCode === 429);
      if (res.statusCode >= 502 && res.statusCode !== 503) registry.markGatewayFailure(target);
      if (res.statusCode === 503) {
        // Could be a simulated gateway failure or an all-backends-down case;
        // the active poller will confirm and correct if needed.
        registry.markGatewayFailure(target);
      }
    } catch (_) {
      registry.markGatewayFailure(target);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'Gateway instance unreachable' }));
      }
    }
  });

  // Real metrics snapshot for the control plane.
  let lastRequests = 0;
  const metricsTimer = setInterval(() => {
    const m = registry.state.metrics;
    const rps = Math.max(0, m.requests - lastRequests);
    lastRequests = m.requests;
    publisher.publish(CHANNELS.METRICS, JSON.stringify({
      source: 'entry-lb', kind: 'entrylb',
      requests: m.requests, success: m.success, failed: m.failed, unauthorized: m.unauthorized,
      rateLimited: m.rateLimited,
      avgLatency: m.requests ? Math.round(m.totalLatencyMs / m.requests) : 0,
      rps, distribution, healthyGateways: registry.healthyGateways(gatewayPorts), ts: Date.now(),
    }));
  }, 1000);

  server.listen(port, () => console.log(`[entry-lb] listening on :${port} -> gateways ${gatewayPorts.join(', ')}`));

  async function close() {
    clearInterval(checker); clearInterval(metricsTimer);
    await new Promise((r) => server.close(r));
    sub.quit(); publisher.quit();
  }
  return { server, close };
}

module.exports = { startEntryLb };
