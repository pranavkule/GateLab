/**
 * Configuration manager (control plane side).
 *
 * Responsibilities: validate rules, persist versioned configs to MongoDB,
 * write audit records, publish updates via Redis Pub/Sub. Gateways listen
 * on the same channel and replace their in-memory tables atomically.
 */
const { RouteConfig, ConfigAudit } = require('../models');
const { CHANNELS, createRedis } = require('../redis');

const VALID_TARGETS = ['users', 'products', 'orders'];

// Optional per-route shared rate limit: { limit, windowMs } or null/absent.
function validateRateLimit(rateLimit, path) {
  if (rateLimit === undefined || rateLimit === null) return null;
  if (typeof rateLimit !== 'object' || Array.isArray(rateLimit)) {
    return `rateLimit must be an object or null for ${path}`;
  }
  if (!Number.isInteger(rateLimit.limit) || rateLimit.limit < 1) {
    return `rateLimit.limit must be a positive integer for ${path}`;
  }
  if (!Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs < 1000 || rateLimit.windowMs > 3600000) {
    return `rateLimit.windowMs must be an integer between 1000 and 3600000 for ${path}`;
  }
  return null;
}

function validateRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return 'Configuration must contain at least one route';
  const seenPaths = new Set();
  for (const r of routes) {
    if (!r.path || typeof r.path !== 'string' || !r.path.startsWith('/')) return `Invalid path: ${JSON.stringify(r.path)}`;
    if (!VALID_TARGETS.includes(r.targetService)) return `Invalid target service: ${r.targetService} (allowed: ${VALID_TARGETS.join(', ')})`;
    if (typeof r.authRequired !== 'boolean') return `authRequired must be true/false for ${r.path}`;
    const rateLimitError = validateRateLimit(r.rateLimit, r.path);
    if (rateLimitError) return rateLimitError;
    if (seenPaths.has(r.path)) return `Duplicate path: ${r.path}`;
    seenPaths.add(r.path);
  }
  return null;
}

async function getLatest() {
  const doc = await RouteConfig.findOne().sort({ version: -1 }).lean();
  return doc;
}

async function seedIfEmpty() {
  const existing = await getLatest();
  if (existing) return existing;
  const { DEFAULT_ROUTES } = require('./index');
  const doc = await RouteConfig.create({ version: 1, routes: DEFAULT_ROUTES, appliedBy: 'system' });
  await ConfigAudit.create({ version: 1, action: 'seed', summary: 'Initial default routing configuration', routes: DEFAULT_ROUTES });
  console.log('[config] seeded initial routing configuration v1');
  return doc.toObject();
}

/**
 * Applies a new routing configuration:
 *  1. validate  2. persist (version++)  3. audit  4. publish via Redis
 * The publish carries the FULL route list so the replacement in every
 * gateway is a single atomic assignment.
 */
async function applyRoutes(routes, changedBy = 'admin') {
  const error = validateRoutes(routes);
  if (error) throw Object.assign(new Error(error), { status: 400 });

  const latest = await getLatest();
  const version = (latest ? latest.version : 0) + 1;
  const doc = await RouteConfig.create({ version, routes, appliedBy: changedBy });
  await ConfigAudit.create({
    version, action: latest ? 'update' : 'create', changedBy,
    summary: `${routes.length} routes (v${latest ? latest.version : 0} -> v${version})`,
    routes,
  });

  const payload = { version, routes, appliedAt: doc.appliedAt };
  const publisher = createRedis();
  await publisher.publish(CHANNELS.CONFIG, JSON.stringify(payload));
  await publisher.quit();
  return payload;
}

module.exports = { validateRoutes, validateRateLimit, getLatest, seedIfEmpty, applyRoutes, VALID_TARGETS };
