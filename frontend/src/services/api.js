// All REST calls the dashboard makes. Live updates arrive over Socket.IO.
// Backend ports come from Vite env vars so two EdgeGate copies can run
// side by side on one machine (see frontend/.env).
const CP = `http://localhost:${import.meta.env.VITE_CONTROL_PLANE_PORT || 5010}`;   // control plane (REST + Socket.IO)
const AUTH = `http://localhost:${import.meta.env.VITE_AUTH_PORT || 5011}`;          // authentication service
const GATEWAY = `http://localhost:${import.meta.env.VITE_ENTRY_LB_PORT || 3010}`;   // entry-point load balancer

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || res.statusText), { status: res.status, body });
  return body;
}

export const api = {
  // status / instances
  getStatus: () => fetch(`${CP}/api/status`).then(json),

  // configuration
  getLatestConfig: () => fetch(`${CP}/api/config/latest`).then(json),
  applyConfig: (routes) => fetch(`${CP}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routes }) }).then(json),
  getConfigHistory: () => fetch(`${CP}/api/config/history`).then(json),

  // logs
  getLogs: (params = '') => fetch(`${CP}/api/logs?${params}`).then(json),
  clearLogs: () => fetch(`${CP}/api/logs`, { method: 'DELETE' }).then(json),

  // failure simulation
  backendAction: (port, action, body) => fetch(`${CP}/api/backend/${port}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(json),
  gatewayAction: (port, action) => fetch(`${CP}/api/gateway/${port}/${action}`, { method: 'POST' }).then(json),

  // reset lab counters (config history preserved)
  resetLab: () => fetch(`${CP}/api/reset`, { method: 'POST' }).then(json),

  // demo tokens (valid / expired / invalid) - secret stays on the server
  demoToken: (type) => fetch(`${CP}/api/demo-token?type=${type}`).then(json),

  // auth service
  login: (username, password) => fetch(`${AUTH}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(json),

  // traffic through the entry-point load balancer
  send: async ({ method = 'GET', path, token }) => {
    const started = performance.now();
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${GATEWAY}${path}`, { method, headers });
      const latency = Math.round(performance.now() - started);
      let body = null;
      try { body = await res.json(); } catch (_) { /* empty body */ }
      return { ok: res.ok, status: res.status, latency, service: body && body.service, instance: body && body.instance };
    } catch (err) {
      return { ok: false, status: 0, latency: Math.round(performance.now() - started), error: err.message };
    }
  },
};

export const SOCKET_URL = CP;
