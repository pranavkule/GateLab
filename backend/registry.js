/**
 * Per-process runtime registry.
 *
 * IMPORTANT: every process (gateway/entry LB) builds its OWN copy of this
 * state from Redis Pub/Sub events + active health checks. We never share a
 * mutable object between processes - that is the whole point of using
 * Pub/Sub for synchronization.
 */
const state = {
  gatewayName: 'gateway',
  // Routing table currently active in THIS process (immutable reference;
  // replaced atomically on config updates, never mutated in place).
  routes: [],
  configVersion: 0,
  // Backend instance health as known locally: { '4001': {healthy:true, failures:0} }
  backends: {},
  // Gateway health as known locally (used by the entry LB): { '3001': {healthy:true} }
  gateways: {},
  // Local metrics counters for this process.
  metrics: { requests: 0, success: 0, failed: 0, unauthorized: 0, totalLatencyMs: 0 },
};

function trackRequest(latencyMs, status, jwtStatus) {
  const m = state.metrics;
  m.requests += 1;
  m.totalLatencyMs += latencyMs;
  if (status >= 200 && status < 400) m.success += 1;
  if (status === 401) m.unauthorized += 1;
  if (status >= 500) m.failed += 1;
}

function resetMetrics() {
  state.metrics = { requests: 0, success: 0, failed: 0, unauthorized: 0, totalLatencyMs: 0 };
}

function setBackendHealth(port, healthy) {
  if (!state.backends[port]) state.backends[port] = { healthy, failures: 0 };
  state.backends[port].healthy = healthy;
  if (healthy) state.backends[port].failures = 0;
}

function markBackendFailure(port) {
  if (!state.backends[port]) state.backends[port] = { healthy: true, failures: 0 };
  const b = state.backends[port];
  b.failures += 1;
  // 3 consecutive failures = circuit opens (passive health)
  if (b.failures >= 3) b.healthy = false;
}

function healthyBackends(service, instances) {
  return (instances || []).filter((p) => {
    const b = state.backends[p];
    return !b || b.healthy !== false;
  });
}

function setGatewayHealth(port, healthy) {
  if (!state.gateways[port]) state.gateways[port] = { healthy, failures: 0 };
  state.gateways[port].healthy = healthy;
  if (healthy) state.gateways[port].failures = 0;
}

function markGatewayFailure(port) {
  if (!state.gateways[port]) state.gateways[port] = { healthy: true, failures: 0 };
  const g = state.gateways[port];
  g.failures += 1;
  if (g.failures >= 2) g.healthy = false;
}

function healthyGateways(ports) {
  return (ports || []).filter((p) => {
    const g = state.gateways[p];
    return !g || g.healthy !== false;
  });
}

// Atomic routing-table replacement: build the new array fully, then swap the
// reference. A request in flight keeps using the old array, so it can never
// observe a partially updated table.
function replaceRoutes(newRoutes, version) {
  const frozen = Object.freeze((newRoutes || []).map((r) => Object.freeze({ ...r })));
  state.routes = frozen;
  state.configVersion = version;
}

module.exports = {
  state,
  trackRequest,
  resetMetrics,
  setBackendHealth,
  markBackendFailure,
  healthyBackends,
  setGatewayHealth,
  markGatewayFailure,
  healthyGateways,
  replaceRoutes,
};
