// All REST calls the dashboard makes. Live updates arrive over Socket.IO.
// Backend ports come from Vite env vars so two EdgeGate copies can run
// side by side on one machine (see frontend/.env).
import { readSessionToken } from './session';

const CP = `http://localhost:${import.meta.env.VITE_CONTROL_PLANE_PORT || 5010}`;   // control plane (REST + Socket.IO)
const AUTH = `http://localhost:${import.meta.env.VITE_AUTH_PORT || 5011}`;          // authentication service
const GATEWAY = `http://localhost:${import.meta.env.VITE_ENTRY_LB_PORT || 3010}`;   // entry-point load balancer

async function requestResult(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  const authToken = token || (base === CP ? readSessionToken() : null);
  if (authToken) requestHeaders.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, body: data });
  return { status: res.status, body: data };
}

function requestJson(base, path, options) {
  return requestResult(base, path, options).then((result) => result.body);
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });
  const value = query.toString();
  return value ? `?${value}` : '';
}

export const api = {
  // status / instances
  getStatus: () => requestJson(CP, '/api/status'),

  // configuration
  getLatestConfig: () => requestJson(CP, '/api/config/latest'),
  applyConfig: (routes) => requestJson(CP, '/api/config', { method: 'PUT', body: { routes } }),
  getConfigHistory: () => requestJson(CP, '/api/config/history'),

  // logs
  getLogs: (params = '') => requestJson(CP, `/api/logs?${params}`),
  clearLogs: () => requestJson(CP, '/api/logs', { method: 'DELETE' }),

  // failure simulation
  backendAction: (port, action, body) => requestJson(CP, `/api/backend/${port}/${action}`, { method: 'POST', body: body || {} }),
  gatewayAction: (port, action) => requestJson(CP, `/api/gateway/${port}/${action}`, { method: 'POST' }),

  // reset lab counters (config history preserved)
  resetLab: () => requestJson(CP, '/api/reset', { method: 'POST' }),

  // demo tokens (valid / expired / invalid) - secret stays on the server
  demoToken: (type) => requestJson(CP, `/api/demo-token?type=${encodeURIComponent(type)}`),

  // auth service
  login: (username, password) => requestJson(AUTH, '/auth/login', { method: 'POST', body: { username, password } }),

  // Customer-facing API traffic goes through the entry load balancer.
  store: {
    register: (body) => requestJson(AUTH, '/auth/register', { method: 'POST', body }),
    customerLogin: (body) => requestJson(AUTH, '/auth/customer-login', { method: 'POST', body }),
    listProducts: (params) => requestJson(GATEWAY, `/api/products${queryString(params)}`),
    getProduct: (id) => requestJson(GATEWAY, `/api/products/${encodeURIComponent(id)}`),
    createOrder: (token, body) => requestJson(GATEWAY, '/api/orders', { method: 'POST', token, body }),
    listOrders: (token, params) => requestJson(GATEWAY, `/api/orders${queryString(params)}`, { token }),
    getOrder: (token, id) => requestJson(GATEWAY, `/api/orders/${encodeURIComponent(id)}`, { token }),
    getProfile: (token) => requestJson(GATEWAY, '/api/users/me', { token }),
    updateProfile: (token, body) => requestJson(GATEWAY, '/api/users/me', { method: 'PUT', token, body }),
    createProduct: (token, body) => requestJson(GATEWAY, '/api/products', { method: 'POST', token, body }),
    updateProduct: (token, id, body) => requestJson(GATEWAY, `/api/products/${encodeURIComponent(id)}`, { method: 'PUT', token, body }),
    deleteProduct: (token, id) => requestJson(GATEWAY, `/api/products/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
    listAdminOrders: (token, params) => requestJson(GATEWAY, `/api/orders/admin${queryString(params)}`, { token }),
    updateOrderStatus: (token, id, status) => requestJson(GATEWAY, `/api/orders/admin/${encodeURIComponent(id)}/status`, { method: 'PUT', token, body: { status } }),
  },

  // traffic through the entry-point load balancer
  send: async ({ method = 'GET', path, token, body }) => {
    const started = performance.now();
    try {
      const result = await requestResult(GATEWAY, path, { method, token, body });
      const latency = Math.round(performance.now() - started);
      return {
        ok: true, status: result.status, latency,
        service: result.body && result.body.service,
        instance: result.body && result.body.instance,
        body: result.body,
      };
    } catch (err) {
      return { ok: false, status: err.status || 0, latency: Math.round(performance.now() - started), error: err.message, body: err.body };
    }
  },
};

export const SOCKET_URL = CP;
