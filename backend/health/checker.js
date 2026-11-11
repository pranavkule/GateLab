/**
 * Active health checker (control plane side).
 *
 * Polls every backend instance (/health) and every gateway
 * (/gateway-health) on a fixed interval and keeps real measured state.
 * This is the ACTIVE half of health checking; gateways additionally do
 * passive health on live traffic failures.
 */
const { SERVICE_META } = require('../config');

function startHealthChecker({ backendPorts, gatewayPorts, intervalMs, onChange }) {
  const backendHealth = {};
  const gatewayHealth = {};

  gatewayPorts.forEach((p) => (gatewayHealth[p] = { port: p, name: `Gateway ${gatewayPorts.indexOf(p) + 1}`, healthy: true, degraded: false }));
  Object.entries(backendPorts).forEach(([service, ports]) => {
    ports.forEach((p) => {
      backendHealth[p] = { port: p, service, name: SERVICE_META[service].name, healthy: true, latencyMs: 0, requestCount: 0, simulated: false };
    });
  });

  async function pollBackends() {
    const jobs = Object.entries(backendHealth).map(async ([port, h]) => {
      const started = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        const body = await res.json().catch(() => ({}));
        const wasHealthy = h.healthy;
        h.healthy = res.ok;
        h.simulated = body.error === 'service_unavailable';
        h.latencyMs = Date.now() - started;
        h.requestCount = body.requestCount != null ? body.requestCount : h.requestCount;
        if (wasHealthy !== h.healthy) console.log(`[health] backend :${port} -> ${h.healthy ? 'UP' : 'DOWN'}`);
      } catch (_) {
        if (h.healthy) console.log(`[health] backend :${port} -> DOWN (unreachable)`);
        h.healthy = false;
        h.simulated = false;
      }
    });
    await Promise.all(jobs);
    onChange && onChange('backend-health', backendHealth);
  }

  async function pollGateways() {
    const jobs = gatewayPorts.map(async (port) => {
      const h = gatewayHealth[port];
      try {
        const res = await fetch(`http://127.0.0.1:${port}/gateway-health`, { signal: AbortSignal.timeout(2000) });
        const wasHealthy = h.healthy;
        h.healthy = res.ok;
        h.simulated = res.status === 503;
        h.degraded = res.ok && (h.latencyMs || 0) > 500;
        if (wasHealthy !== h.healthy) console.log(`[health] gateway :${port} -> ${h.healthy ? 'UP' : 'DOWN'}`);
      } catch (_) {
        h.healthy = false;
        h.simulated = false;
      }
    });
    await Promise.all(jobs);
    onChange && onChange('gateway-health', gatewayHealth);
  }

  const timer = setInterval(() => { pollBackends(); pollGateways(); }, intervalMs);
  // First pass right away.
  setTimeout(() => { pollBackends(); pollGateways(); }, 300);

  function close() { clearInterval(timer); }
  return { backendHealth, gatewayHealth, pollBackends, pollGateways, close };
}

module.exports = { startHealthChecker };
