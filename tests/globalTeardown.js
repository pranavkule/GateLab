const fs = require('fs');
const path = require('path');

module.exports = async function globalTeardown() {
  const pidFile = path.join(__dirname, '.test-stack.pid');
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid) process.kill(pid);
    fs.unlinkSync(pidFile);
  } catch (_) { /* already gone */ }
  // give the child a moment to release ports
  await new Promise((r) => setTimeout(r, 1000));
};
