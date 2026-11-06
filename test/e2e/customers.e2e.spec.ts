import request from 'supertest';

import { hmacSha256Hex, nationalIdHmac } from '@/common/crypto/crypto';
import { TransactionRunner } from '@/common/database/transaction-runner';

import {
  customerBody,
  IDENTITY_MODULES,
  type PageBody,
  registerCustomer,
  type RegistrationBody,
} from '../fixtures/identity';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

describe('Customers', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    t = await createTestApp(IDENTITY_MODULES);
    tenant = await createTestTenant(t.app);
    other = await createTestTenant(t.app);
  });

  afterAll(async () => {
    await t.close();
  });

  const get = (path: string, token: string) =>
    request(t.http).get(path).set('Authorization', `Bearer ${token}`);

  describe('self-registration', () => {
    it('creates a verified customer, signs them in, and never returns or stores the raw BVN', async () => {
      const body = customerBody();
      const res = await registerCustomer(t.http, tenant.slug, body).expect(201);
      const { customer, tokens } = res.body as RegistrationBody;
      expect(customer).toMatchObject({
        reference: expect.stringMatching(/^CUS-[A-Z0-9]{6}$/),
        customerType: 'BUSINESS',
        kycStatus: 'VERIFIED',
        nationalIdLast4: String(body.nationalId).slice(-4),
        monthlyIncome: '150000000',
        existingMonthlyDebt: '0',
      });
      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain(String(body.nationalId));
      expect(serialised).not.toMatch(/hmac|password/i);
      expect(tokens.accessToken).toEqual(expect.any(String));

      const row = await t.app
        .get(TransactionRunner)
        .runForTenant(tenant.tenantId, (tx) =>
          tx
            .selectFrom('customers')
            .select(['national_id_hmac', 'national_id_last4'])
            .where('id', '=', customer.id)
            .executeTakeFirstOrThrow(),
        );
      // Per-tenant key (HKDF of BVN_HMAC_KEY with the tenant id).
      expect(row.national_id_hmac).toBe(
        nationalIdHmac(process.env.BVN_HMAC_KEY!, tenant.tenantId, String(body.nationalId)),
      );
      expect(row.national_id_hmac).not.toBe(
        hmacSha256Hex(process.env.BVN_HMAC_KEY!, String(body.nationalId)),
      );

      const me = await get('/v1/customers/me', tokens.accessToken).expect(200);
      expect(me.body.id).toBe(customer.id);
      // The new customer can also sign in with the chosen password.
      await request(t.http)
        .post('/v1/auth/login')
        .send({ institutionSlug: tenant.slug, email: body.email, password: body.password })
        .expect(200);
    });

    it('leaves KYC PENDING for ids the mock provider cannot match (000 prefix)', async () => {
      const res = await registerCustomer(t.http, tenant.slug, {
        nationalId: `000${String(Date.now()).slice(-8)}`,
      }).expect(201);
      expect(res.body.customer.kycStatus).toBe('PENDING');
    });

    it('answers a duplicate national id and a duplicate email with the same generic 409', async () => {
      const body = customerBody();
      await registerCustomer(t.http, tenant.slug, body).expect(201);
      const byId = await registerCustomer(t.http, tenant.slug, {
        nationalId: body.nationalId,
      }).expect(409);
      const byEmail = await registerCustomer(t.http, tenant.slug, {
        email: String(body.email).toUpperCase(),
      }).expect(409);
      for (const dup of [byId, byEmail]) {
        expect(dup.body.code).toBe('REGISTRATION_CONFLICT');
        expect(dup.body.detail).toBe('Registration could not be completed with these details');
      }
      expect(byId.body.type).toBe(byEmail.body.type);
      // The same person may bank with another institution.
      await registerCustomer(t.http, other.slug, { nationalId: body.nationalId }).expect(201);
    });

    it('validates input', async () => {
      const cases: Record<string, unknown>[] = [
        { nationalId: '1234' },
        { phone: '08012345678' },
        { dateOfBirth: '1985-02-30' },
        { monthlyIncome: '1500.50' },
        { monthlyIncome: 1500 },
        { businessName: undefined },
        { password: 'weakpassword' },
        { kycStatus: 'VERIFIED' },
      ];
      for (const overrides of cases) {
        const res = await registerCustomer(t.http, tenant.slug, overrides);
        expect(res.status, JSON.stringify(overrides)).toBe(400);
      }
      const ccy = await registerCustomer(t.http, tenant.slug, { currency: 'USD' }).expect(422);
      expect(ccy.body.code).toBe('UNSUPPORTED_CURRENCY');
      await registerCustomer(t.http, 'no-such-lender').expect(404);
    });

    it('allows INDIVIDUAL customers without business fields', async () => {
      const res = await registerCustomer(t.http, tenant.slug, {
        customerType: 'INDIVIDUAL',
        businessName: undefined,
        businessRegistrationNumber: undefined,
        employmentStatus: 'EMPLOYED',
        employerName: 'Lagos University Teaching Hospital',
      }).expect(201);
      expect(res.body.customer).toMatchObject({ customerType: 'INDIVIDUAL', businessName: null });
    });
  });

  describe('reading customers', () => {
    it('lets a customer read only their own record (others are 404) and not the list (403)', async () => {
      const a = (await registerCustomer(t.http, tenant.slug).expect(201)).body as RegistrationBody;
      const b = (await registerCustomer(t.http, tenant.slug).expect(201)).body as RegistrationBody;

      await get(`/v1/customers/${a.customer.id}`, a.tokens.accessToken).expect(200);
      const foreign = await get(`/v1/customers/${b.customer.id}`, a.tokens.accessToken).expect(404);
      expect(foreign.body.code).toBe('NOT_FOUND');
      await get('/v1/customers', a.tokens.accessToken).expect(403);
    });

    it('lets staff list and read any customer of their institution', async () => {
      const a = (await registerCustomer(t.http, tenant.slug).expect(201)).body as RegistrationBody;
      const one = await get(`/v1/customers/${a.customer.id}`, tenant.tokens.CREDIT_OFFICER).expect(
        200,
      );
      expect(one.body.monthlyIncome).toBe('150000000');
      const list = await get('/v1/customers?limit=100', tenant.tokens.AUDITOR).expect(200);
      expect((list.body as PageBody).items.map((c) => c.id)).toContain(a.customer.id);
      expect(JSON.stringify(list.body)).not.toMatch(/hmac/i);
      await get('/v1/customers/me', tenant.tokens.CREDIT_OFFICER).expect(404);
      await get('/v1/customers/not-a-uuid', tenant.tokens.CREDIT_OFFICER).expect(400);
    });

    it('isolates tenants: another institution cannot see these customers, even by id', async () => {
      const a = (await registerCustomer(t.http, tenant.slug).expect(201)).body as RegistrationBody;
      await get(`/v1/customers/${a.customer.id}`, other.tokens.INSTITUTION_ADMIN).expect(404);
      const list = await get('/v1/customers?limit=100', other.tokens.INSTITUTION_ADMIN).expect(200);
      expect((list.body as PageBody).items.map((c) => c.id)).not.toContain(a.customer.id);

      // A customer token of tenant A is useless against tenant B's data as well.
      const b = (await registerCustomer(t.http, other.slug).expect(201)).body as RegistrationBody;
      await get(`/v1/customers/${b.customer.id}`, a.tokens.accessToken).expect(404);
    });
  });
});
