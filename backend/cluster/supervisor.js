/**
 * Worker supervisor for the cluster launcher (P2.6.1).
 *
 * Policy:
 *   - A worker that exits unexpectedly (not during intentional shutdown) is
 *     reforked with the SAME role/env spec after a backoff, so a crashed
 *     process does not reduce capacity silently while the container health
 *     check stays green.
 *   - Restart budgets are tracked independently per worker spec: at most
 *     maxRestarts refork attempts within windowMs. Once exhausted, the
 *     supervisor stops respawning that worker and logs a loud error instead
 *     of crashing-looping forever.
 *   - Backoff doubles per consecutive restart within the window and is capped
 *     at maxBackoffMs.
 *   - No respawn ever happens once shutdown() was called (intentional stop).
 */
function createSupervisor({
  fork,
  specs,
  respawn = true,
  maxRestarts = 5,
  windowMs = 60000,
  backoffMs = 1000,
  maxBackoffMs = 10000,
  shutdownTimeoutMs = 10000,
  forceKillTimeoutMs = 1000,
  log = (level, msg) => (level === 'error' ? console.error(msg) : console.log(msg)),
}) {
  const restartLimit = Number.isInteger(maxRestarts) && maxRestarts >= 0 ? maxRestarts : 5;
  const restartWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;
  const initialBackoffMs = Number.isFinite(backoffMs) && backoffMs > 0 ? backoffMs : 1000;
  const backoffCapMs = Number.isFinite(maxBackoffMs) && maxBackoffMs > 0 ? maxBackoffMs : 10000;
  const gracefulShutdownMs = Number.isFinite(shutdownTimeoutMs) && shutdownTimeoutMs > 0 ? shutdownTimeoutMs : 10000;
  const forceKillWaitMs = Number.isFinite(forceKillTimeoutMs) && forceKillTimeoutMs > 0 ? forceKillTimeoutMs : 1000;
  const records = specs.map((spec) => ({
    spec,
    worker: null,
    restartTimes: [],
    timer: null,
    exhausted: false,
  }));

  let globalShutdown = false;
  let shutdownPromise = null;

  function countRecent(record) {
    const now = Date.now();
    while (record.restartTimes.length && now - record.restartTimes[0] > restartWindowMs) {
      record.restartTimes.shift();
    }
    return record.restartTimes.length;
  }

  function respawnAfter(record, delay) {
    if (globalShutdown) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = null;
      if (globalShutdown) return;
      forkRecord(record);
    }, delay);
  }

  function scheduleRestart(record, reason) {
    if (globalShutdown) return;
    if (!respawn) {
      log('warn', `[supervisor] worker ${record.spec.label} ${reason} - respawn disabled`);
      return;
    }

    const recent = countRecent(record);
    if (record.exhausted || recent >= restartLimit) {
      record.exhausted = true;
      log('error', `[supervisor] worker ${record.spec.label} ${reason} - restart budget exhausted (${recent}/${restartLimit} reforks within ${restartWindowMs}ms), NOT respawning. Manual intervention required.`);
      return;
    }

    const attempt = recent + 1;
    record.restartTimes.push(Date.now());
    const delay = Math.min(initialBackoffMs * 2 ** (attempt - 1), backoffCapMs);
    log('warn', `[supervisor] worker ${record.spec.label} ${reason} - refork ${attempt}/${restartLimit} in ${delay}ms`);
    respawnAfter(record, delay);
  }

  function forkRecord(record) {
    try {
      const worker = fork(record.spec);
      record.worker = worker;
      worker.on('exit', (code, signal) => {
        record.worker = null;
        scheduleRestart(record, `exited (code ${code}, signal ${signal})`);
      });
    } catch (err) {
      scheduleRestart(record, `failed to fork: ${err.message}`);
    }
  }

  function start() {
    records.forEach((record) => forkRecord(record));
  }

  function workers() {
    return records.filter((r) => r.worker).map((r) => r.worker);
  }

  /** Intentional shutdown: stop respawning and wait for workers to close. */
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    globalShutdown = true;
    records.forEach((r) => {
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    });
    const pending = records.map((record) => {
      const worker = record.worker;
      if (!worker) return Promise.resolve();
      return new Promise((resolve) => {
        let finished = false;
        let gracefulTimer;
        let forceKillTimer;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(gracefulTimer);
          clearTimeout(forceKillTimer);
          worker.removeListener('exit', finish);
          resolve();
        };
        worker.once('exit', finish);
        gracefulTimer = setTimeout(() => {
          log('error', `[supervisor] worker ${record.spec.label} did not exit within ${gracefulShutdownMs}ms - sending SIGKILL`);
          try {
            const sent = worker.process.kill('SIGKILL');
            if (sent === false) { finish(); return; }
          } catch (err) {
            log('error', `[supervisor] failed to force-stop worker ${record.spec.label}: ${err.message}`);
            finish();
            return;
          }
          if (!finished) forceKillTimer = setTimeout(finish, forceKillWaitMs);
        }, gracefulShutdownMs);
        try {
          const sent = worker.process.kill('SIGTERM');
          if (sent === false) finish();
        } catch (err) {
          log('error', `[supervisor] failed to stop worker ${record.spec.label}: ${err.message}`);
          try { worker.process.kill('SIGKILL'); } catch (killError) {
            log('error', `[supervisor] failed to force-stop worker ${record.spec.label}: ${killError.message}`);
          }
          finish();
        }
      });
    });
    shutdownPromise = Promise.all(pending);
    return shutdownPromise;
  }

  return { start, workers, shutdown };
}

module.exports = { createSupervisor };
