import { randomInt } from 'node:crypto';

import request from 'supertest';

import { registerCustomer, type RegistrationBody } from '../fixtures/identity';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

/** A fresh client IP per scenario: counters live in the Redis shared by every test file. */
const freshIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('Rate limits (tenant budgets per principal class, pre-auth, sign-up)', () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await createTestApp([], {
      RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE: '4',
      RATE_LIMIT_PUBLIC_PER_MINUTE: '3',
      SIGNUP_RATE_LIMIT_PER_HOUR: '2',
      CORS_ORIGINS: 'https://lender.example',
    });
    tenant = await createTestTenant(t.app);
  });

  afterAll(async () => {
    await t.close();
  });

  const register = (slug: string) =>
    registerCustomer(t.http, slug).set('X-Forwarded-For', freshIp());

  it('caps new customer registrations per institution (signup budget, 429 + Retry-After)', async () => {
    const lender = await createTestTenant(t.app);
    await register(lender.slug).expect(201);
    await register(lender.slug).expect(201);
    const res = await register(lender.slug).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Another institution is unaffected.
    await register(tenant.slug).expect(201);
  });

  it('customers exhausting their tenant budget do not affect the lender’s staff', async () => {
    const lender = await createTestTenant(t.app);
    const customers = [
      ((await register(lender.slug).expect(201)).body as RegistrationBody).tokens.accessToken,
      ((await register(lender.slug).expect(201)).body as RegistrationBody).tokens.accessToken,
    ];
    const me = (token: string) =>
      request(t.http)
        .get('/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', freshIp());

    // Two different customers share the tenant-customer budget (4/min here).
    for (let i = 0; i < 4; i++) await me(customers[i % 2] ?? '').expect(200);
    const limited = await me(customers[0] ?? '').expect(429);
    expect(limited.headers['ratelimit-policy']).toContain('"tenant-customer"');

    const staff = await request(t.http)
      .get('/v1/users')
      .set('Authorization', `Bearer ${lender.tokens.INSTITUTION_ADMIN}`)
      .expect(200);
    expect(staff.headers['ratelimit-policy']).toContain('"tenant-staff"');
  });

  it('charges bad tokens to the anonymous per-IP budget before authentication', async () => {
    const ip = freshIp();
    const attempt = (token: string) =>
      request(t.http)
        .get('/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i++) await attempt('not-a-jwt').expect(401);
    const limited = await attempt('not-a-jwt').expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    // A valid token from the same address is not charged to that budget.
    await attempt(tenant.tokens.INSTITUTION_ADMIN).expect(200);
  });

  it('charges slug-routed public requests before any routing lookup', async () => {
    const ip = freshIp();
    const branding = () =>
      request(t.http).get('/v1/institutions/no-such-lender/branding').set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i++) await branding().expect(404);
    const limited = await branding().expect(429);
    expect(limited.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(limited.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts one request once even when middleware and guard both check it', async () => {
    const ip = freshIp();
    const res = await request(t.http)
      .get(`/v1/institutions/${tenant.slug}/branding`)
      .set('X-Forwarded-For', ip)
      .expect(200);
    expect(res.headers.ratelimit).toMatch(/"anonymous";r=2;/);
  });

  it('exposes the RateLimit headers to browser front ends (CORS)', async () => {
    const res = await request(t.http)
      .get(`/v1/institutions/${tenant.slug}/branding`)
      .set('Origin', 'https://lender.example')
      .set('X-Forwarded-For', freshIp())
      .expect(200);
    const exposed = String(res.headers['access-control-expose-headers']);
    expect(exposed).toContain('RateLimit');
    expect(exposed).toContain('RateLimit-Policy');
  });
});
