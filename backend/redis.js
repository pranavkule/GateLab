require('dotenv').config();

﻿const Redis = require('ioredis');
const REDIS_URL = process.env.REDIS_URL ||
  (process.env.NODE_ENV === 'production' ? null : 'redis://localhost:6381');

if (!REDIS_URL) {
  throw new Error('REDIS_URL is required in production');
}
if (process.env.NODE_ENV === 'production') {
  let parsed;
  try { parsed = new URL(REDIS_URL); } catch (_) {
    throw new Error('REDIS_URL must be a valid authenticated Redis connection URL in production');
  }
  if (!parsed.password) {
    throw new Error('REDIS_URL must include a Redis password in production');
  }
}

// Channels used across processes (see docs/architecture.md)
const CHANNELS = {
  CONFIG: 'edgegate:config',       // routing config updates (full snapshot)
  LOGS: 'edgegate:logs',           // request log records from gateways
  METRICS: 'edgegate:metrics',     // periodic metric snapshots
  BACKEND_CMD: 'edgegate:backend-cmd', // fail/recover/latency/errors commands
  GATEWAY_CMD: 'edgegate:gateway-cmd', // gateway fail/recover commands
  RESET: 'edgegate:reset',         // reset counters everywhere
};

function createRedis() {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 3, retryStrategy: (t) => Math.min(t * 50, 2000) }).on('error', (e) => console.error('[redis]', e.message));
}

// Subscriber connections must skip the ready-check (info is not allowed in
// subscriber mode) and swallow transient reconnection errors.
function createSubscriber() {
  return new Redis(REDIS_URL, { retryStrategy: (t) => Math.min(t * 50, 2000), enableReadyCheck: false, maxRetriesPerRequest: null })
    .on('error', (e) => console.error('[redis-sub]', e.message));
}

module.exports = { CHANNELS, createRedis, createSubscriber, REDIS_URL };
