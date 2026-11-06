import request from 'supertest';

import { CheckoutOrders } from '@/modules/lending/application/ports/checkout-orders.port';

import { StrictFakeCheckoutOrders, STRICT_FAKE_VENDOR } from '../fixtures/checkout-orders';
import {
  bearer,
  createProduct,
  idemKey,
  LENDING_MODULES,
  ngnMonthlyTerms,
  registerScoredCustomer,
  type TestCustomer,
} from '../fixtures/lending';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

/**
 * Checkout (VENDOR-mode) orders are bound to the applicant, bound the principal, and finance
 * at most one live application per institution (SPEC §7.1; V5 `loan_applications_order_once`).
 */
describe('Checkout order binding', () => {
  const apply = (t: TestApp, token: string, body: Record<string, unknown>, key = idemKey()) =>
    request(t.http)
      .post('/v1/loan-applications')
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);

  describe('with an adapter that attests buyer and total (strict fake)', () => {
    const orders = new StrictFakeCheckoutOrders();
    let t: TestApp;
    let ngn: TestTenant;
    let product: string;
    let alice: TestCustomer;
    let bob: TestCustomer;

    const body = (orderReference: string, principal = '50000000') => ({
      productId: product,
      principal,
      term: 3,
      externalOrderReference: orderReference,
    });

    beforeAll(async () => {
      t = await createTestApp(LENDING_MODULES, {}, (b) =>
        b.overrideProvider(CheckoutOrders).useValue(orders),
      );
      ngn = await createTestTenant(t.app);
      product = await createProduct(t.http, ngn, ngnMonthlyTerms({ disbursementMode: 'VENDOR' }));
      alice = await registerScoredCustomer(t.http, ngn);
      bob = await registerScoredCustomer(t.http, ngn);
    });

    afterAll(() => t.close());

    it('refuses a principal above the order total (422 ORDER_AMOUNT_EXCEEDED)', async () => {
      const order = orders.place(alice.id, 40_000_000n);
      const res = await apply(t, alice.token, body(order, '40000001')).expect(422);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        code: 'ORDER_AMOUNT_EXCEEDED',
        externalOrderReference: order,
        orderTotal: '40000000',
      });

      // Exactly the total (or less) is fine and pays the order's vendor.
      const ok = await apply(t, alice.token, body(order, '40000000')).expect(201);
      expect(ok.body).toMatchObject({
        requestedPrincipal: '40000000',
        payee: { type: 'VENDOR', ...STRICT_FAKE_VENDOR },
        externalOrderReference: order,
      });
    });

    it('refuses another customer’s order (422 ORDER_NOT_FOR_APPLICANT), also via staff', async () => {
      const alicesOrder = orders.place(alice.id, 90_000_000n);
      const res = await apply(t, bob.token, body(alicesOrder)).expect(422);
      expect(res.body).toMatchObject({
        code: 'ORDER_NOT_FOR_APPLICANT',
        externalOrderReference: alicesOrder,
      });
      // The buyer check comes first: nothing about the order (e.g. its total) leaks.
      expect(res.body).not.toHaveProperty('orderTotal');
      const overTotal = await apply(t, bob.token, body(alicesOrder, '99000000')).expect(422);
      expect(overTotal.body.code).toBe('ORDER_NOT_FOR_APPLICANT');

      const staff = await apply(t, ngn.tokens.CREDIT_OFFICER, {
        ...body(alicesOrder),
        customerId: bob.id,
      }).expect(422);
      expect(staff.body.code).toBe('ORDER_NOT_FOR_APPLICANT');

      // The buyer can finance it, and a credit officer can on the buyer's behalf... once.
      await apply(t, ngn.tokens.CREDIT_OFFICER, {
        ...body(alicesOrder),
        customerId: alice.id,
      }).expect(201);
      const again = await apply(t, alice.token, body(alicesOrder)).expect(409);
      expect(again.body.code).toBe('ORDER_ALREADY_FINANCED');
    });
  });

  describe('with the mock procurement platform (no buyer / total attestation)', () => {
    let t: TestApp;
    let ngn: TestTenant;
    let other: TestTenant;
    let product: string;
    let otherProduct: string;
    let alice: TestCustomer;
    let bob: TestCustomer;
    let sequence = 0;

    /** A fresh demo order reference the mock adapter resolves. */
    const newOrder = () => `ORD-2026-${Date.now()}-${++sequence}`;
    const body = (orderReference: string, productId = product) => ({
      productId,
      principal: '50000000',
      term: 3,
      externalOrderReference: orderReference,
    });
    const decide = (id: string, action: 'reject' | 'withdraw', token: string) =>
      request(t.http)
        .post(`/v1/loan-applications/${id}/${action}`)
        .set(bearer(token))
        .send(action === 'reject' ? { reasonCodes: ['R02_LOW_BUREAU_SCORE'] } : {});

    beforeAll(async () => {
      t = await createTestApp(LENDING_MODULES);
      ngn = await createTestTenant(t.app);
      other = await createTestTenant(t.app);
      product = await createProduct(t.http, ngn, ngnMonthlyTerms({ disbursementMode: 'VENDOR' }));
      otherProduct = await createProduct(
        t.http,
        other,
        ngnMonthlyTerms({ disbursementMode: 'VENDOR' }),
      );
      alice = await registerScoredCustomer(t.http, ngn);
      bob = await registerScoredCustomer(t.http, ngn);
    });

    afterAll(() => t.close());

    it('a second live application for the same order is 409 ORDER_ALREADY_FINANCED', async () => {
      const order = newOrder();
      const first = await apply(t, alice.token, body(order)).expect(201);

      for (const token of [alice.token, bob.token]) {
        const res = await apply(t, token, body(order)).expect(409);
        expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(res.body).toMatchObject({
          code: 'ORDER_ALREADY_FINANCED',
          externalOrderReference: order,
        });
      }

      // Still held once assessed.
      await request(t.http)
        .post(`/v1/loan-applications/${first.body.id as string}/assess`)
        .set(bearer(ngn.tokens.CREDIT_OFFICER))
        .expect(200);
      expect((await apply(t, bob.token, body(order)).expect(409)).body.code).toBe(
        'ORDER_ALREADY_FINANCED',
      );
    });

    it('an idempotent replay returns the original application, not a 409', async () => {
      const order = newOrder();
      const key = idemKey();
      const first = await apply(t, alice.token, body(order), key).expect(201);
      const replay = await apply(t, alice.token, body(order), key).expect(201);
      expect(replay.body.id).toBe(first.body.id);
    });

    it('a rejected or withdrawn application frees the order', async () => {
      const order = newOrder();
      const rejected = await apply(t, alice.token, body(order)).expect(201);
      await decide(rejected.body.id as string, 'reject', ngn.tokens.CREDIT_OFFICER).expect(200);

      const withdrawn = await apply(t, alice.token, body(order)).expect(201);
      await decide(withdrawn.body.id as string, 'withdraw', alice.token).expect(200);

      const reused = await apply(t, bob.token, body(order)).expect(201);
      expect(reused.body.externalOrderReference).toBe(order);
    });

    it('single use is per institution: another lender may finance the same order', async () => {
      const order = newOrder();
      await apply(t, alice.token, body(order)).expect(201);
      const carol = await registerScoredCustomer(t.http, other);
      const theirs = await apply(t, carol.token, body(order, otherProduct)).expect(201);
      // ...and the other institution's application does not exist from here.
      await request(t.http)
        .get(`/v1/loan-applications/${theirs.body.id as string}`)
        .set(bearer(ngn.tokens.AUDITOR))
        .expect(404);
    });

    it('concurrent submissions of one order: exactly one wins (unique index), one gets 409', async () => {
      const order = newOrder();
      const results = await Promise.all([
        apply(t, alice.token, body(order)),
        apply(t, bob.token, body(order)),
        apply(t, alice.token, body(order)),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.code).toBe('ORDER_ALREADY_FINANCED');
      }
    });
  });
});
