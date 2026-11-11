require('dotenv').config();

// Service catalog: targetService key -> instances (from env or defaults).
function parseBackendInstances() {
  const raw = process.env.BACKEND_INSTANCES || '4001:users,4004:users,4002:products,4005:products,4003:orders,4006:orders';
  const list = raw.split(',').map((s) => {
    const [port, service] = s.trim().split(':');
    return { port: Number(port), service };
  });
  const map = { users: [], products: [], orders: [] };
  list.forEach(({ port, service }) => {
    if (!map[service]) map[service] = [];
    map[service].push(port);
  });
  return map;
}

const SERVICE_META = {
  users: { name: 'User Service', route: '/api/users/*' },
  products: { name: 'Product Service', route: '/api/products/*' },
  orders: { name: 'Order Service', route: '/api/orders/*' },
};

function backendInstances() {
  return parseBackendInstances();
}

const DEFAULT_ROUTES = [
  { id: 'r-users', path: '/api/users/*', targetService: 'users', authRequired: true, enabled: true },
  { id: 'r-products', path: '/api/products/*', targetService: 'products', authRequired: false, enabled: true },
  { id: 'r-orders', path: '/api/orders/*', targetService: 'orders', authRequired: true, enabled: true },
];

module.exports = { SERVICE_META, DEFAULT_ROUTES, backendInstances };
