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
  // Backend instance availability as known locally:
  // { '4001': {hardDown:false, failures:0} }
  // hardDown is ONLY the administrative Fail/Recover state (BACKEND_CMD).
  // Ordinary forwarding failures are tracked by the Redis-backed circuit
  // breaker (P2.5.1), never by flipping a local healthy flag here - that
  // would permanently hide an instance and block HALF-OPEN probing.
  // `failures` stays as a passive diagnostics counter only.
  backends: {},
  // Gateway health as known locally (used by the entry LB): { '3011': {healthy:true} }
  gateways: {},
  // Local metrics counters for this process.
  metrics: { requests: 0, success: 0, failed: 0, unauthorized: 0, rateLimited: 0, totalLatencyMs: 0 },
};

function trackRequest(latencyMs, status, jwtStatus, rateLimited) {
  const m = state.metrics;
  m.requests += 1;
  m.totalLatencyMs += latencyMs;
  if (status >= 200 && status < 400) m.success += 1;
  if (status === 401) m.unauthorized += 1;
  if (status === 429 || rateLimited) m.rateLimited += 1;
  if (status >= 500) m.failed += 1;
}

function resetMetrics() {
  state.metrics = { requests: 0, success: 0, failed: 0, unauthorized: 0, rateLimited: 0, totalLatencyMs: 0 };
}

function setBackendHealth(port, healthy) {
  if (!state.backends[port]) state.backends[port] = { hardDown: false, failures: 0 };
  state.backends[port].hardDown = !healthy;
  if (healthy) state.backends[port].failures = 0;
}

function markBackendFailure(port) {
  if (!state.backends[port]) state.backends[port] = { hardDown: false, failures: 0 };
  state.backends[port].failures += 1;
  // P2.5.1: passive failures NEVER flip local availability. Circuit
  // exclusion (open/half-open probe limiting) is owned by the shared
  // Redis-backed circuit breaker; active health checks + manual Recover
  // stay the authoritative availability signals.
}

function isBackendHardDown(port) {
  const b = state.backends[port];
  return Boolean(b && b.hardDown);
}

function healthyBackends(service, instances) {
  return (instances || []).filter((p) => {
    const b = state.backends[p];
    return !b || b.hardDown !== true;
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
  isBackendHardDown,
  healthyBackends,
  setGatewayHealth,
  markGatewayFailure,
  healthyGateways,
  replaceRoutes,
};
