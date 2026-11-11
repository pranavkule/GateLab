const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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
