const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, '.test-stack.pid');
const READY_URL = 'http://localhost:15000/api/status';

module.exports = async function globalSetup() {
  const child = spawn(process.execPath, [path.join(__dirname, 'stackRunner.js')], { stdio: 'inherit' });
  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(READY_URL);
      if (res.ok) return;
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Test stack did not become ready in 45s (MongoDB/Redis running?)');
};
