import request from 'supertest';

import { createTestApp, type TestApp } from '../setup/app';

describe('HTTP foundation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports readiness of Postgres and Redis', async () => {
    const res = await request(t.http).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('echoes a request id for log correlation', async () => {
    const res = await request(t.http).get('/health/live').set('X-Request-ID', 'trace-abc-123');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('renders unknown routes as RFC 9457 problem details without internals', async () => {
    const res = await request(t.http).get('/v1/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      instance: '/v1/does-not-exist',
    });
    expect(res.body.traceId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/);
  });

  it('sets security headers', async () => {
    const res = await request(t.http).get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
