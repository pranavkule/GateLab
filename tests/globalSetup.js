const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  getTestMongoUri,
  getTestRedisUrl,
  assertDisposableTestServices,
} = require('./testTargetSafety');

const PID_FILE = path.join(__dirname, '.test-stack.pid');
const READY_URL = 'http://localhost:15000/health';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);

  if (child.exitCode === null && child.signalCode === null) {
    const killed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await Promise.race([killed, delay(3000)]);
  }

  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Could not stop test stack process ${child.pid}`);
  }
}

module.exports = async function globalSetup() {
  if (!process.env.JEST_TEST_MONGO_URI || !process.env.JEST_TEST_REDIS_URL) {
    throw new Error('Set explicit disposable JEST_TEST_MONGO_URI and JEST_TEST_REDIS_URL before running Jest');
  }
  getTestMongoUri();
  getTestRedisUrl();
  assertDisposableTestServices();

  const child = spawn(process.execPath, [path.join(__dirname, 'stackRunner.js')], {
    stdio: 'inherit',
    env: { ...process.env, EDGEGATE_JEST_MANAGED_STACK: '1' },
  });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });

  try {
    if (!child.pid) throw new Error('Could not start the test stack process');
    fs.writeFileSync(PID_FILE, String(child.pid));

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Test stack exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
      }
      try {
        const res = await fetch(READY_URL);
        if (res.ok) return;
      } catch (_) { /* not ready yet */ }
      await delay(500);
    }
    throw new Error('Test stack did not become ready in 45s (MongoDB/Redis running?)');
  } catch (error) {
    try {
      await stopChild(child);
    } catch (cleanupError) {
      console.error(`[jest-setup] ${cleanupError.message}`);
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error(`[jest-setup] ${cleanupError.message}`);
    }
    throw error;
  }
};
