/**
 * TEST 12: performance - real load through the entry load balancer.
 * Uses autocannon to generate load and reports actual measured
 * throughput and latency (no fake numbers).
 */
const autocannon = require('autocannon');
const ENTRY = 'http://localhost:14100';

test('TEST 12: sustained load with ~0 errors and measurable throughput', async () => {
  const result = await autocannon({
    url: `${ENTRY}/api/products`,
    duration: 3,
    connections: 10,
  });

  console.log('--- Performance results (real measured values) ---');
  console.log(`Requests completed : ${result.requests.total}`);
  console.log(`Throughput         : ${Math.round(result.requests.average)} req/s`);
  console.log(`Latency avg        : ${Math.round(result.latency.average)} ms`);
  console.log(`Latency p97        : ${result.latency.p97} ms`);
  console.log(`Errors             : ${result.errors + result.non2xx}`);
  console.log('--------------------------------------------------');

  expect(result.requests.total).toBeGreaterThanOrEqual(100);
  expect(result.errors).toBe(0);
  expect(result.non2xx).toBe(0);
  expect(result.latency.average).toBeLessThan(500);
}, 60000);
