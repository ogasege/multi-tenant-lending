import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { TokenService } from '@/common/auth/token.service';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { LoanProductsModule } from '@/modules/loan-products/loan-products.module';

import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

const ngnTerms = (overrides: Record<string, unknown> = {}) => ({
  currency: 'NGN',
  minPrincipal: '1000000', // ₦10,000.00
  maxPrincipal: '100000000', // ₦1,000,000.00
  minTerm: 3,
  maxTerm: 24,
  repaymentFrequency: 'MONTHLY',
  interestMethod: 'REDUCING_BALANCE',
  annualInterestRateBps: 2400,
  originationFee: { type: 'NONE', value: '0', treatment: 'DEDUCTED' },
  lateFee: { type: 'FLAT', value: '500000', graceDays: 3 },
  maxDtiBps: 4000,
  minCreditScore: 550,
  applicationExpiryDays: 14,
  disbursementMode: 'BORROWER',
  ...overrides,
});

const bulletTerms = (overrides: Record<string, unknown> = {}) =>
  ngnTerms({
    minTerm: 14,
    maxTerm: 90,
    repaymentFrequency: 'BULLET',
    annualInterestRateBps: 3000,
    originationFee: { type: 'PERCENTAGE', value: '100', treatment: 'DEDUCTED' },
    disbursementMode: 'VENDOR',
    ...overrides,
  });

interface QuoteBody {
  totalRepayable: string;
  totalInterest: string;
  instalments: { principal: string }[];
}

/** Product ids of a list page. */
const itemIds = (body: unknown): string[] =>
  (body as { items: { id: string }[] }).items.map((p) => p.id);

const code = () => `P${randomUUID().slice(0, 8).toUpperCase()}`;

/** 20 % flat weekly with a 3 % deducted fee: all-in APR well above 24 %. */
const xofWeeklyTerms = () =>
  ngnTerms({
    currency: 'XOF',
    minPrincipal: '50000',
    maxPrincipal: '5000000',
    repaymentFrequency: 'WEEKLY',
    interestMethod: 'FLAT',
    annualInterestRateBps: 2000,
    originationFee: { type: 'PERCENTAGE', value: '300', treatment: 'DEDUCTED' },
    minTerm: 4,
    maxTerm: 26,
  });

describe('Loan products', () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let xof: TestTenant;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const create = (tenant: TestTenant, body: object, token = tenant.tokens.INSTITUTION_ADMIN) =>
    request(t.http).post('/v1/loan-products').set(auth(token)).send(body);
  const createOk = async (tenant: TestTenant, terms: object = ngnTerms()) =>
    (await create(tenant, { code: code(), name: 'Product', terms }).expect(201)).body as {
      id: string;
      currentVersion: number;
    };
  const quote = (tenant: TestTenant, id: string, body: object) =>
    request(t.http)
      .post(`/v1/loan-products/${id}/quote`)
      .set(auth(tenant.tokens.CREDIT_OFFICER))
      .send(body);

  beforeAll(async () => {
    t = await createTestApp([LoanProductsModule]);
    a = await createTestTenant(t.app, { maxAprBps: 6000 });
    b = await createTestTenant(t.app);
    xof = await createTestTenant(t.app, {
      currency: 'XOF',
      lenderType: 'MICROFINANCE_INSTITUTION',
      maxAprBps: 2400,
    });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('create', () => {
    it('creates a product with version 1, audit and outbox event', async () => {
      const productCode = code();
      const res = await create(a, {
        code: productCode,
        name: '  Pharmacy restock  ',
        description: 'Working capital for pharmacies',
        terms: ngnTerms(),
      }).expect(201);
      expect(res.body).toMatchObject({
        code: productCode,
        name: 'Pharmacy restock',
        status: 'ACTIVE',
        currentVersion: 1,
        terms: {
          version: 1,
          currency: 'NGN',
          minPrincipal: '1000000',
          maxPrincipal: '100000000',
          annualInterestRateBps: 2400,
          dayCount: 'ACT_365F',
          originationFee: { type: 'NONE', value: '0', treatment: 'DEDUCTED' },
          lateFee: { type: 'FLAT', value: '500000', graceDays: 3 },
          minCreditScore: 550,
          disbursementMode: 'BORROWER',
        },
      });

      const { audit, events } = await t.app
        .get(TransactionRunner)
        .runForTenant(a.tenantId, async (tx) => ({
          audit: await tx
            .selectFrom('audit_log')
            .select(['action', 'actor_id'])
            .where('entity_id', '=', res.body.id as string)
            .execute(),
          events: await tx
            .selectFrom('outbox_events')
            .select('event_type')
            .where('aggregate_id', '=', res.body.id as string)
            .execute(),
        }));
      expect(audit).toEqual([
        { action: 'loan_product.created', actor_id: a.userIds.INSTITUTION_ADMIN },
      ]);
      expect(events).toEqual([{ event_type: 'loan_product.created' }]);
    });

    it('applies defaults for optional underwriting settings', async () => {
      const terms = ngnTerms();
      for (const k of [
        'maxDtiBps',
        'minCreditScore',
        'applicationExpiryDays',
        'disbursementMode',
      ]) {
        Reflect.deleteProperty(terms, k);
      }
      const res = await create(a, { code: code(), name: 'Defaults', terms }).expect(201);
      expect(res.body.terms).toMatchObject({
        maxDtiBps: 4000,
        minCreditScore: 0,
        applicationExpiryDays: 14,
        disbursementMode: 'VENDOR',
      });
    });

    it('rejects a duplicate code within the tenant (409) but allows it in another tenant', async () => {
      const productCode = code();
      await create(a, { code: productCode, name: 'One', terms: ngnTerms() }).expect(201);
      const dup = await create(a, { code: productCode, name: 'Two', terms: ngnTerms() }).expect(
        409,
      );
      expect(dup.body.code).toBe('DUPLICATE');
      await create(b, { code: productCode, name: 'Other tenant', terms: ngnTerms() }).expect(201);
    });

    it.each([
      ['a decimal amount', { minPrincipal: '1000.50' }, 'terms.minPrincipal'],
      ['a numeric amount', { maxPrincipal: 100000000 }, 'terms.maxPrincipal'],
      ['an inverted range', { minPrincipal: '5000000', maxPrincipal: '10' }, 'maxPrincipal'],
      ['an unknown frequency', { repaymentFrequency: 'YEARLY' }, 'terms.repaymentFrequency'],
      ['a BULLET tenor below 7 days', { repaymentFrequency: 'BULLET', minTerm: 3 }, 'minTerm'],
      ['a BULLET tenor above 365 days', { repaymentFrequency: 'BULLET', maxTerm: 400 }, 'maxTerm'],
    ])('rejects %s (400)', async (_label, patch, field) => {
      const res = await create(a, { code: code(), name: 'Bad', terms: ngnTerms(patch) }).expect(
        400,
      );
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });

    it('rejects mass assignment of status/tenantId', async () => {
      const res = await create(a, {
        code: code(),
        name: 'Sneaky',
        status: 'ARCHIVED',
        tenantId: b.tenantId,
        terms: ngnTerms(),
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a currency the institution does not offer (422)', async () => {
      const res = await create(a, {
        code: code(),
        name: 'CFA',
        terms: ngnTerms({ currency: 'XOF' }),
      }).expect(422);
      expect(res.body.code).toBe('UNSUPPORTED_CURRENCY');
    });

    it('enforces the institution APR cap on the nominal rate (422 APR_EXCEEDS_CAP)', async () => {
      const xofTerms = ngnTerms({
        currency: 'XOF',
        minPrincipal: '50000',
        maxPrincipal: '5000000',
      });
      const over = await create(xof, {
        code: code(),
        name: 'Too expensive',
        terms: { ...xofTerms, annualInterestRateBps: 2401 },
      }).expect(422);
      expect(over.body).toMatchObject({ code: 'APR_EXCEEDS_CAP', aprBps: 2401, maxAprBps: 2400 });
      await create(xof, {
        code: code(),
        name: 'At the cap',
        terms: { ...xofTerms, annualInterestRateBps: 2400 },
      }).expect(201);
    });

    it('rejects terms whose worst-case ALL-IN APR (fees included) exceeds the cap', async () => {
      // Nominal 20 % is under the 24 % cap, but a 3 % fee over 4 weeks is not.
      const res = await create(xof, { code: code(), name: 'Fee-heavy', terms: xofWeeklyTerms() });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('APR_EXCEEDS_CAP');
      expect(res.body.aprBps).toBeGreaterThan(2400);
    });
  });

  describe('RBAC', () => {
    it('denies product creation to a credit officer', async () => {
      const res = await create(
        a,
        { code: code(), name: 'Nope', terms: ngnTerms() },
        a.tokens.CREDIT_OFFICER,
      ).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('lets an auditor read but not write', async () => {
      const product = await createOk(a);
      await request(t.http)
        .get(`/v1/loan-products/${product.id}`)
        .set(auth(a.tokens.AUDITOR))
        .expect(200);
      await request(t.http).get('/v1/loan-products').set(auth(a.tokens.AUDITOR)).expect(200);
      await request(t.http)
        .patch(`/v1/loan-products/${product.id}/status`)
        .set(auth(a.tokens.AUDITOR))
        .send({ status: 'ARCHIVED' })
        .expect(403);
      await request(t.http)
        .post(`/v1/loan-products/${product.id}/versions`)
        .set(auth(a.tokens.AUDITOR))
        .send({ expectedVersion: 1, terms: ngnTerms() })
        .expect(403);
    });

    it('requires authentication', async () => {
      await request(t.http).get('/v1/loan-products').expect(401);
    });
  });

  describe('versioning', () => {
    it('adds immutable versions and keeps old terms intact', async () => {
      const product = await createOk(a);
      const v2 = await request(t.http)
        .post(`/v1/loan-products/${product.id}/versions`)
        .set(auth(a.tokens.INSTITUTION_ADMIN))
        .send({ expectedVersion: 1, terms: ngnTerms({ annualInterestRateBps: 3000 }) })
        .expect(201);
      expect(v2.body).toMatchObject({
        currentVersion: 2,
        terms: { version: 2, annualInterestRateBps: 3000 },
      });

      const detail = await request(t.http)
        .get(`/v1/loan-products/${product.id}`)
        .set(auth(a.tokens.CREDIT_OFFICER))
        .expect(200);
      expect(detail.body.terms.annualInterestRateBps).toBe(3000);
      const versions = (detail.body as { versions: { version: number }[] }).versions;
      expect(versions.map((v) => v.version)).toEqual([2, 1]);

      const v1 = await request(t.http)
        .get(`/v1/loan-products/${product.id}/versions/1`)
        .set(auth(a.tokens.CREDIT_OFFICER))
        .expect(200);
      expect(v1.body).toMatchObject({ version: 1, annualInterestRateBps: 2400 });

      // The database itself refuses to rewrite a published version.
      await expect(
        t.app
          .get(TransactionRunner)
          .runForTenant(a.tenantId, (tx) =>
            tx
              .updateTable('loan_product_versions')
              .set({ annual_interest_rate_bps: 1 })
              .where('product_id', '=', product.id)
              .execute(),
          ),
      ).rejects.toThrow();
    });

    it('rejects a stale expectedVersion (409 CONCURRENT_MODIFICATION)', async () => {
      const product = await createOk(a);
      const post = (expectedVersion: number) =>
        request(t.http)
          .post(`/v1/loan-products/${product.id}/versions`)
          .set(auth(a.tokens.INSTITUTION_ADMIN))
          .send({ expectedVersion, terms: ngnTerms() });
      await post(1).expect(201);
      const stale = await post(1).expect(409);
      expect(stale.body).toMatchObject({ code: 'CONCURRENT_MODIFICATION', currentVersion: 2 });
    });

    it('validates new versions against the APR cap too', async () => {
      const product = await createOk(a);
      const res = await request(t.http)
        .post(`/v1/loan-products/${product.id}/versions`)
        .set(auth(a.tokens.INSTITUTION_ADMIN))
        .send({ expectedVersion: 1, terms: ngnTerms({ annualInterestRateBps: 6001 }) })
        .expect(422);
      expect(res.body.code).toBe('APR_EXCEEDS_CAP');
    });
  });

  describe('borrower view', () => {
    it('shows customers ACTIVE products only, without underwriting thresholds or authors', async () => {
      const tenant = await createTestTenant(t.app);
      const active = await createOk(tenant);
      const archived = await createOk(tenant);
      await request(t.http)
        .patch(`/v1/loan-products/${archived.id}/status`)
        .set(auth(tenant.tokens.INSTITUTION_ADMIN))
        .send({ status: 'ARCHIVED' })
        .expect(200);
      const customer = t.app.get(TokenService).issueAccessToken({
        kind: 'USER',
        id: randomUUID(),
        tenantId: tenant.tenantId,
        role: 'CUSTOMER',
      }).accessToken;

      for (const query of ['', '?status=ARCHIVED']) {
        const list = await request(t.http)
          .get(`/v1/loan-products${query}`)
          .set(auth(customer))
          .expect(200);
        expect(itemIds(list.body)).toEqual([active.id]);
      }
      const detail = await request(t.http)
        .get(`/v1/loan-products/${active.id}`)
        .set(auth(customer))
        .expect(200);
      const json = JSON.stringify(detail.body);
      expect(json).not.toMatch(/minCreditScore|maxDtiBps|createdBy/);
      expect(detail.body.terms.annualInterestRateBps).toBe(2400);
      await request(t.http).get(`/v1/loan-products/${archived.id}`).set(auth(customer)).expect(404);
      await request(t.http)
        .get(`/v1/loan-products/${archived.id}/versions/1`)
        .set(auth(customer))
        .expect(404);
      const version = await request(t.http)
        .get(`/v1/loan-products/${active.id}/versions/1`)
        .set(auth(customer))
        .expect(200);
      expect(version.body.minCreditScore).toBeUndefined();

      // Staff still see everything.
      const staff = await request(t.http)
        .get(`/v1/loan-products/${active.id}`)
        .set(auth(tenant.tokens.CREDIT_OFFICER))
        .expect(200);
      expect(staff.body.terms).toMatchObject({ minCreditScore: 550, maxDtiBps: 4000 });
      expect(staff.body.versions[0].createdBy).toBe(tenant.userIds.INSTITUTION_ADMIN);
    });
  });

  describe('status and listing', () => {
    it('archives a product, filters by status, and blocks new versions and quotes', async () => {
      const tenant = await createTestTenant(t.app);
      const active = await createOk(tenant);
      const archived = await createOk(tenant);
      const res = await request(t.http)
        .patch(`/v1/loan-products/${archived.id}/status`)
        .set(auth(tenant.tokens.INSTITUTION_ADMIN))
        .send({ status: 'ARCHIVED' })
        .expect(200);
      expect(res.body.status).toBe('ARCHIVED');

      const list = await request(t.http)
        .get('/v1/loan-products?status=ACTIVE')
        .set(auth(tenant.tokens.AUDITOR))
        .expect(200);
      expect(itemIds(list.body)).toEqual([active.id]);

      const version = await request(t.http)
        .post(`/v1/loan-products/${archived.id}/versions`)
        .set(auth(tenant.tokens.INSTITUTION_ADMIN))
        .send({ expectedVersion: 1, terms: ngnTerms() })
        .expect(422);
      expect(version.body.code).toBe('PRODUCT_NOT_ACTIVE');
      const q = await quote(tenant, archived.id, { principal: '5000000', term: 6 }).expect(422);
      expect(q.body.code).toBe('PRODUCT_NOT_ACTIVE');
    });

    it('paginates with a cursor and caps the page size at 100', async () => {
      const tenant = await createTestTenant(t.app);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await createOk(tenant)).id);
      const page1 = await request(t.http)
        .get('/v1/loan-products?limit=2')
        .set(auth(tenant.tokens.AUDITOR))
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await request(t.http)
        .get(`/v1/loan-products?limit=2&cursor=${page1.body.nextCursor as string}`)
        .set(auth(tenant.tokens.AUDITOR))
        .expect(200);
      expect(page2.body).toMatchObject({ nextCursor: null });
      const seen = [...page1.body.items, ...page2.body.items].map((p: { id: string }) => p.id);
      expect(seen.sort()).toEqual(ids.sort());
      await request(t.http)
        .get('/v1/loan-products?limit=101')
        .set(auth(tenant.tokens.AUDITOR))
        .expect(400);
    });
  });

  describe('tenant isolation', () => {
    it('hides tenant A’s product from tenant B (404 on read, version, status, quote)', async () => {
      const product = await createOk(a);
      const asB = (req: request.Test) => req.set(auth(b.tokens.INSTITUTION_ADMIN));
      const read = await asB(request(t.http).get(`/v1/loan-products/${product.id}`)).expect(404);
      expect(read.body.code).toBe('NOT_FOUND');
      await asB(request(t.http).get(`/v1/loan-products/${product.id}/versions/1`)).expect(404);
      await asB(request(t.http).post(`/v1/loan-products/${product.id}/versions`))
        .send({ expectedVersion: 1, terms: ngnTerms() })
        .expect(404);
      await asB(request(t.http).patch(`/v1/loan-products/${product.id}/status`))
        .send({ status: 'ARCHIVED' })
        .expect(404);
      await asB(request(t.http).post(`/v1/loan-products/${product.id}/quote`))
        .send({ principal: '5000000', term: 6 })
        .expect(404);

      const listB = await asB(request(t.http).get('/v1/loan-products?limit=100')).expect(200);
      expect(itemIds(listB.body)).not.toContain(product.id);

      // Tenant A's product is unchanged.
      const still = await request(t.http)
        .get(`/v1/loan-products/${product.id}`)
        .set(auth(a.tokens.AUDITOR))
        .expect(200);
      expect(still.body).toMatchObject({ status: 'ACTIVE', currentVersion: 1 });
    });

    it('rejects a malformed id with 400', async () => {
      await request(t.http)
        .get('/v1/loan-products/not-a-uuid')
        .set(auth(a.tokens.AUDITOR))
        .expect(400);
    });
  });

  describe('quote', () => {
    it('quotes an NGN reducing-balance loan with a sane schedule and APR', async () => {
      const product = await createOk(a);
      const res = await quote(a, product.id, {
        principal: '10000000',
        term: 12,
        disbursementDate: '2026-01-31',
      }).expect(200);
      const q = res.body;
      expect(q).toMatchObject({
        productVersion: 1,
        currency: 'NGN',
        principal: '10000000',
        termUnit: 'INSTALMENTS',
        originationFee: '0',
        financedPrincipal: '10000000',
        netDisbursed: '10000000',
        aprBps: 2400,
        maxAprBps: 6000,
        aprWithinCap: true,
        maturityDate: '2027-01-31',
      });
      expect(q.instalments).toHaveLength(12);
      // ₦100,000 at 2 %/month: level payment ₦9,455.96; Feb clamps to the 28th.
      expect(q.instalments[0]).toMatchObject({ dueDate: '2026-02-28', total: '945596' });
      const typed = q as QuoteBody;
      const principalSum = typed.instalments.reduce((s, i) => s + BigInt(i.principal), 0n);
      expect(principalSum).toBe(10_000_000n);
      expect(BigInt(typed.totalRepayable)).toBe(10_000_000n + BigInt(typed.totalInterest));
      expect(q.totalCostOfCredit).toBe(q.totalInterest);
      expect(Number(q.totalInterest)).toBeGreaterThan(1_340_000);
      expect(Number(q.totalInterest)).toBeLessThan(1_355_000);
    });

    it('quotes an NGN 30-day BULLET with a deducted fee in the APR', async () => {
      const product = await createOk(a, bulletTerms());
      const q = (
        await quote(a, product.id, {
          principal: '50000000',
          term: 30,
          disbursementDate: '2026-03-01',
        }).expect(200)
      ).body;
      // Interest 500 000.00 × 30 % × 30 / 365 = ₦12,328.77; fee 1 % = ₦5,000.00 deducted.
      expect(q).toMatchObject({
        termUnit: 'DAYS',
        interestMethod: 'SIMPLE',
        originationFee: '500000',
        netDisbursed: '49500000',
        totalInterest: '1232877',
        totalRepayable: '51232877',
        totalCostOfCredit: '1732877',
        maturityDate: '2026-03-31',
      });
      expect(q.instalments).toEqual([
        {
          seq: 1,
          dueDate: '2026-03-31',
          principal: '50000000',
          interest: '1232877',
          total: '51232877',
        },
      ]);
      // (51 232 877 / 49 500 000 − 1) × 365 / 30 ≈ 42.59 %.
      expect(q.aprBps).toBeGreaterThan(4250);
      expect(q.aprBps).toBeLessThan(4270);
      expect(q.aprWithinCap).toBe(true);
    });

    it('quotes an XOF product (no minor unit) and flags an APR above a cap lowered later', async () => {
      // All-in APR above 24 % cannot be CREATED under a 24 % cap (worst-case check), so the
      // product is created uncapped and the regulator's cap is applied afterwards.
      const capped = await createTestTenant(t.app, {
        currency: 'XOF',
        lenderType: 'MICROFINANCE_INSTITUTION',
        maxAprBps: null,
      });
      const product = await createOk(capped, xofWeeklyTerms());
      await t.app
        .get(TransactionRunner)
        .asPlatformAdmin((tx) =>
          tx
            .updateTable('institutions')
            .set({ max_apr_bps: 2400 })
            .where('id', '=', capped.tenantId)
            .execute(),
        );
      const q = (
        await quote(capped, product.id, {
          principal: '1000000',
          term: 12,
          disbursementDate: '2026-06-01',
        }).expect(200)
      ).body;
      // Flat interest 1 000 000 × 20 % × 12 / 52 = 46 153.85 → 46 154 FCFA.
      expect(q).toMatchObject({
        currency: 'XOF',
        totalInterest: '46154',
        originationFee: '30000',
        netDisbursed: '970000',
        totalCostOfCredit: '76154',
        maxAprBps: 2400,
        aprWithinCap: false,
      });
      expect(q.instalments).toHaveLength(12);
      expect(q.instalments[0].dueDate).toBe('2026-06-08');
      for (const i of q.instalments) expect(i.total).toMatch(/^\d+$/);
      expect(q.aprBps).toBeGreaterThan(2400);
    });

    it('defaults the disbursement date to today', async () => {
      const product = await createOk(a);
      const res = await quote(a, product.id, { principal: '5000000', term: 3 }).expect(200);
      expect(res.body.disbursementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it.each([
      [{ principal: '999999', term: 12 }, 'AMOUNT_OUT_OF_PRODUCT_RANGE'],
      [{ principal: '100000001', term: 12 }, 'AMOUNT_OUT_OF_PRODUCT_RANGE'],
      [{ principal: '5000000', term: 2 }, 'TERM_OUT_OF_PRODUCT_RANGE'],
      [{ principal: '5000000', term: 25 }, 'TERM_OUT_OF_PRODUCT_RANGE'],
    ])('rejects %o with 422 %s', async (body, expected) => {
      const product = await createOk(a);
      const res = await quote(a, product.id, body).expect(422);
      expect(res.body.code).toBe(expected);
    });

    it('rejects an impossible calendar date', async () => {
      const product = await createOk(a);
      await quote(a, product.id, {
        principal: '5000000',
        term: 3,
        disbursementDate: '2026-02-30',
      }).expect(400);
    });

    it('persists nothing (no audit rows)', async () => {
      const product = await createOk(a);
      const before = await t.app.get(TransactionRunner).runForTenant(a.tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirst(),
      );
      await quote(a, product.id, { principal: '5000000', term: 3 }).expect(200);
      const after = await t.app.get(TransactionRunner).runForTenant(a.tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirst(),
      );
      expect(after?.n).toBe(before?.n);
    });
  });
});
