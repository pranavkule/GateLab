const request = require('supertest');
const { createServiceApp } = require('../backend/services/microservice');

describe('Microservice readiness', () => {
  test('reports unavailable when its database is disconnected', async () => {
    const app = createServiceApp({
      port: 4011,
      service: 'users',
      isReady: () => false,
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('service_unavailable');
    expect(response.body.message).toContain('not ready');
  });
});
