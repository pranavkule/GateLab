// Centralized port configuration for the dashboard.
// All values come from Vite env vars (frontend/.env) so two EdgeGate copies
// can run side by side without code changes.
const env = import.meta.env;

export const ENTRY_LB_PORT = env.VITE_ENTRY_LB_PORT || 3010;

export const GATEWAY_PORTS = String(env.VITE_GATEWAY_PORTS || '3011,3012,3013')
  .split(',').map((p) => String(p).trim()).filter(Boolean);

// "port:service" list, grouped per service key: { users: ['4011','4014'], ... }
export const BACKEND_INSTANCES = String(env.VITE_BACKEND_INSTANCES || '4011:users,4014:users,4012:products,4015:products,4013:orders,4016:orders')
  .split(',')
  .map((s) => s.trim().split(':'))
  .reduce((acc, [port, service]) => {
    (acc[service] = acc[service] || []).push(port);
    return acc;
  }, {});

export const SERVICE_NAMES = {
  users: 'User Service',
  products: 'Product Service',
  orders: 'Order Service',
};
