const { execFileSync } = require('child_process');

const TEST_STACK_PROJECT = 'gatelab-p261-test';
const DEFAULT_TEST_MONGO_URI = 'mongodb://127.0.0.1:27018/edgegate_test';
const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6380';

function parseLocalUrl(value, protocol, port, pathname, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be an explicit local disposable test target`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(`${label} must be a valid local disposable test URL`);
  }

  if (
    parsed.protocol !== protocol ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== String(port) ||
    parsed.pathname !== pathname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${label} must target the dedicated local disposable test service`);
  }
  return parsed;
}

function validateTestMongoUri(uri) {
  const parsed = parseLocalUrl(uri, 'mongodb:', 27019, '/edgegate_test', 'JEST_TEST_MONGO_URI');
  if (parsed.searchParams.size !== 1 || parsed.searchParams.get('directConnection') !== 'true') {
    throw new Error('JEST_TEST_MONGO_URI must pin directConnection=true to the disposable test container');
  }
  return uri;
}

function validateTestRedisUrl(url) {
  const parsed = parseLocalUrl(url, 'redis:', 6381, '/0', 'JEST_TEST_REDIS_URL');
  if (parsed.search) {
    throw new Error('JEST_TEST_REDIS_URL must not include query options');
  }
  return url;
}

function getTestMongoUri() {
  if (process.env.JEST_TEST_MONGO_URI !== undefined) {
    return validateTestMongoUri(process.env.JEST_TEST_MONGO_URI);
  }
  if (process.env.JEST_WORKER_ID !== undefined || process.env.EDGEGATE_JEST_MANAGED_STACK === '1') {
    throw new Error('JEST_TEST_MONGO_URI is required to run Jest against the disposable test database');
  }
  return DEFAULT_TEST_MONGO_URI;
}

function getTestRedisUrl() {
  if (process.env.JEST_TEST_REDIS_URL !== undefined) {
    return validateTestRedisUrl(process.env.JEST_TEST_REDIS_URL);
  }
  if (process.env.JEST_WORKER_ID !== undefined || process.env.EDGEGATE_JEST_MANAGED_STACK === '1') {
    throw new Error('JEST_TEST_REDIS_URL is required to run Jest against disposable Redis');
  }
  return DEFAULT_TEST_REDIS_URL;
}

function inspectDisposableService({ service, image, portKey, hostPort, tmpfsPaths, mongoReplicaSet }) {
  const filterArgs = [
    '--filter', `label=com.docker.compose.project=${TEST_STACK_PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`,
  ];
  let ids;
  try {
    ids = execFileSync('docker', ['ps', '--quiet', ...filterArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/).filter(Boolean);
  } catch (_) {
    throw new Error(`Docker is unavailable; start the isolated ${service} service before Jest`);
  }
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one running ${service} container in Compose project ${TEST_STACK_PROJECT}`);
  }

  let container;
  try {
    const inspected = execFileSync('docker', ['inspect', ids[0]], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    [container] = JSON.parse(inspected);
  } catch (_) {
    throw new Error(`Could not inspect the isolated ${service} container`);
  }

  const labels = (container.Config && container.Config.Labels) || {};
  const networks = Object.keys((container.NetworkSettings && container.NetworkSettings.Networks) || {});
  if (
    container.Config.Image !== image ||
    labels['com.docker.compose.project'] !== TEST_STACK_PROJECT ||
    labels['com.docker.compose.service'] !== service ||
    networks.length !== 1 ||
    networks[0] !== `${TEST_STACK_PROJECT}_runtime_testnet` ||
    container.State.Status !== 'running' ||
    !container.State.Health ||
    container.State.Health.Status !== 'healthy'
  ) {
    throw new Error(`The ${service} container does not match the healthy disposable test configuration`);
  }

  const tmpfs = (container.HostConfig && container.HostConfig.Tmpfs) || {};
  const configuredTmpfs = Object.keys(tmpfs).sort();
  if (
    configuredTmpfs.join('|') !== [...tmpfsPaths].sort().join('|') ||
    (container.HostConfig.Binds && container.HostConfig.Binds.length > 0) ||
    (container.Mounts || []).some((mount) => mount.Type !== 'tmpfs')
  ) {
    throw new Error(`The ${service} container has a persistent or unexpected data mount`);
  }

  const bindings = ((container.NetworkSettings || {}).Ports || {})[portKey] || [];
  if (!bindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === String(hostPort))) {
    throw new Error(`The ${service} port is not bound exclusively to the expected local test port`);
  }

  if (mongoReplicaSet) {
    const command = container.Config.Cmd || [];
    if (!command.includes('--replSet') || !command.includes('rs0')) {
      throw new Error('The disposable MongoDB container must run the rs0 replica set required by integration tests');
    }
  }
}

function assertDisposableTestServices() {
  inspectDisposableService({
    service: 'test-mongodb',
    image: 'mongo:7',
    portKey: '27017/tcp',
    hostPort: 27019,
    tmpfsPaths: ['/data/db', '/data/configdb'],
    mongoReplicaSet: true,
  });
  inspectDisposableService({
    service: 'test-redis',
    image: 'redis:7-alpine',
    portKey: '6379/tcp',
    hostPort: 6381,
    tmpfsPaths: ['/data'],
  });

  let projectContainers;
  try {
    const output = execFileSync('docker', [
      'ps', '--quiet',
      '--filter', `label=com.docker.compose.project=${TEST_STACK_PROJECT}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    projectContainers = output.trim().split(/\r?\n/).filter(Boolean);
  } catch (_) {
    throw new Error('Could not verify the isolated Jest Compose project');
  }
  if (projectContainers.length !== 2) {
    throw new Error('Stop the runtime profile before running Jest; only its two isolated data services may run');
  }
}

module.exports = {
  DEFAULT_TEST_MONGO_URI,
  DEFAULT_TEST_REDIS_URL,
  getTestMongoUri,
  getTestRedisUrl,
  validateTestMongoUri,
  validateTestRedisUrl,
  assertDisposableTestServices,
};
