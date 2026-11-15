/**
 * TEST SUITE (P2.6.1): worker supervisor unit tests.
 *
 * Verifies the respawn policy of backend/cluster/supervisor.js against a fake
 * cluster fork (no real child processes):
 *   - unexpected exits trigger a refork with the SAME spec after backoff
 *   - backoff doubles per consecutive restart within the window
 *   - restart budgets are per worker spec and exhaustable
 *   - no respawn while (or after) intentional shutdown
 */
const { EventEmitter } = require('events');
const { createSupervisor } = require('../backend/cluster/supervisor');

function fakeWorker() {
  const w = new EventEmitter();
  w.process = {
    kill: jest.fn((signal = 'SIGTERM') => {
      setImmediate(() => w.emit('exit', 0, signal));
      return true;
    }),
  };
  return w;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSpecs(labels) {
  return labels.map((label) => ({ label, role: label, env: {} }));
}

describe('Worker supervisor (P2.6.1)', () => {
  test('respawns an unexpectedly exited worker with the same spec after backoff', async () => {
    const specs = makeSpecs(['entrylb']);
    const forks = [];
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 10,
      maxBackoffMs: 100,
      log: () => {},
    });
    sup.start();
    expect(forks.length).toBe(1);
    forks[0].w.emit('exit', 1, null);
    await sleep(40);
    expect(forks.length).toBe(2); // respawned
    expect(forks[1].spec).toBe(specs[0]); // same spec object
    await sup.shutdown();
  });

  test('applies increasing backoff between consecutive restarts', async () => {
    const forks = [];
    const specs = makeSpecs(['gw']);
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 20,
      maxBackoffMs: 10000,
      maxRestarts: 10,
      windowMs: 60000,
      log: () => {},
    });
    sup.start();
    forks[0].w.emit('exit', 1, null);
    await sleep(10);
    expect(forks.length).toBe(1); // still in backoff window
    await sleep(30);
    expect(forks.length).toBe(2); // first restart after ~20ms

    forks[1].w.emit('exit', 1, null);
    await sleep(30);
    expect(forks.length).toBe(2); // second backoff is ~40ms
    await sleep(60);
    expect(forks.length).toBe(3);
    await sup.shutdown();
  });

  test('exhausts the per-worker restart budget and stops respawning', async () => {
    const forks = [];
    const specs = makeSpecs(['be']);
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 5,
      maxRestarts: 3,
      windowMs: 60000,
      log: () => {},
    });
    sup.start();
    let last = forks[0];
    for (let i = 0; i < 3; i += 1) {
      last.w.emit('exit', 1, null);
      await sleep(30);
      const now = forks[forks.length - 1];
      expect(now).not.toBe(last);
      last = now;
    }
    // maxRestarts=3 allows three reforks after the initial worker.
    expect(forks.length).toBe(4);
    last.w.emit('exit', 1, null);
    await sleep(40);
    expect(forks.length).toBe(4);
    await sup.shutdown();
  });

  test('restart budgets are tracked independently per worker spec', async () => {
    const specs = makeSpecs(['crasher', 'stable']);
    const forks = [];
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 5,
      maxRestarts: 2,
      windowMs: 60000,
      log: () => {},
    });
    sup.start();
    const crasher = forks.find((f) => f.spec.label === 'crasher');
    const stable = forks.find((f) => f.spec.label === 'stable');
    // Exhaust the crasher budget (maxRestarts=2 => 2 reforks).
    let w = crasher;
    for (let i = 0; i < 2; i += 1) {
      w.w.emit('exit', 1, null);
      await sleep(25);
      w = forks.filter((f) => f.spec.label === 'crasher').slice(-1)[0];
    }
    const crasherForks = forks.filter((f) => f.spec.label === 'crasher').length;
    expect(crasherForks).toBe(3); // initial + 2 respawns
    // One more crash: budget exhausted, no respawn for crasher.
    w.w.emit('exit', 1, null);
    await sleep(30);
    expect(forks.filter((f) => f.spec.label === 'crasher').length).toBe(3);
    // The stable worker still respawns: its own budget is untouched.
    stable.w.emit('exit', 0, null);
    await sleep(30);
    expect(forks.filter((f) => f.spec.label === 'stable').length).toBe(2);
    await sup.shutdown();
  });

  test('never respawns during or after intentional shutdown', async () => {
    const specs = makeSpecs(['gw-a', 'gw-b']);
    const forks = [];
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 5,
      log: () => {},
    });
    sup.start();
    await sup.shutdown();
    // All live workers were killed by shutdown().
    expect(forks.filter((f) => f.spec.label === 'gw-a')[0].w.process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(forks.filter((f) => f.spec.label === 'gw-b')[0].w.process.kill).toHaveBeenCalledWith('SIGTERM');
    // Exits after shutdown trigger no refork.
    forks.forEach((f) => f.w.emit('exit', 0, null));
    await sleep(40);
    expect(forks.length).toBe(2);
  });

  test('pending backoff timers do not refork once shutdown begins', async () => {
    const forks = [];
    const specs = makeSpecs(['gw']);
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 30,
      log: () => {},
    });
    sup.start();
    forks[0].w.emit('exit', 1, null); // schedules refork in ~30ms
    await sup.shutdown(); // cancel before the timer fires
    await sleep(60);
    expect(forks.length).toBe(1);
  });

  test('workers() lists live workers for shutdown orchestration', async () => {
    const specs = makeSpecs(['x', 'y']);
    const forks = [];
    const sup = createSupervisor({
      fork: (spec) => { const w = fakeWorker(); forks.push({ spec, w }); return w; },
      specs,
      backoffMs: 5,
      log: () => {},
    });
    sup.start();
    expect(sup.workers().length).toBe(2);
    forks[0].w.emit('exit', 1, null);
    await sleep(20);
    expect(sup.workers().length).toBe(2); // respawned worker replaces the dead one
    await sup.shutdown();
    forks.forEach((f) => f.w.emit('exit', 0, null));
    expect(sup.workers().length).toBe(0);
  });

  test('fork failure schedules a retry instead of crashing the launcher', async () => {
    let calls = 0;
    const specs = makeSpecs(['gw']);
    const sup = createSupervisor({
      fork: () => {
        calls += 1;
        if (calls === 1) throw new Error('fork failed once');
        return fakeWorker();
      },
      specs,
      backoffMs: 5,
      log: () => {},
    });
    sup.start();
    await sleep(30);
    expect(calls).toBe(2); // retried after the failure
    await sup.shutdown();
  });

  test('bounds repeated synchronous fork failures by the per-worker budget', async () => {
    let calls = 0;
    const sup = createSupervisor({
      fork: () => {
        calls += 1;
        throw new Error('fork remains unavailable');
      },
      specs: makeSpecs(['broken']),
      maxRestarts: 2,
      backoffMs: 5,
      log: () => {},
    });
    sup.start();
    await sleep(50);
    expect(calls).toBe(3); // initial attempt plus two bounded reforks
    await sleep(30);
    expect(calls).toBe(3); // exhausted workers do not retry forever
    await sup.shutdown();
  });

  test('waits for workers to exit gracefully before completing shutdown', async () => {
    const worker = fakeWorker();
    worker.process.kill = jest.fn((signal) => {
      if (signal === 'SIGTERM') setTimeout(() => worker.emit('exit', 0, signal), 20);
      return true;
    });
    const sup = createSupervisor({
      fork: () => worker,
      specs: makeSpecs(['worker']),
      shutdownTimeoutMs: 100,
      log: () => {},
    });
    sup.start();

    const started = Date.now();
    await sup.shutdown();

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(worker.process.kill).toHaveBeenCalledTimes(1);
    expect(worker.process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sup.workers()).toHaveLength(0);
  });

  test('force-stops workers that exceed the graceful shutdown deadline', async () => {
    const worker = fakeWorker();
    worker.process.kill = jest.fn((signal) => {
      if (signal === 'SIGKILL') setImmediate(() => worker.emit('exit', null, signal));
      return true;
    });
    const sup = createSupervisor({
      fork: () => worker,
      specs: makeSpecs(['hung']),
      shutdownTimeoutMs: 10,
      forceKillTimeoutMs: 50,
      log: () => {},
    });
    sup.start();

    await sup.shutdown();

    expect(worker.process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(worker.process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });
});
