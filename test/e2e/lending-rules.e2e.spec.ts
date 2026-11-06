import request from 'supertest';

import { TransactionRunner } from '@/common/database/transaction-runner';

import {
  applyAndApprove,
  balances,
  bearer,
  createProduct,
  delinquentScore,
  disburse,
  idemKey,
  LENDING_MODULES,
  LONG_LIVED_TOKENS,
  ngnMonthlyTerms,
  registerScoredCustomer,
  repay,
  runEndOfDay,
  itemIds,
  type TestCustomer,
  type TrialBalanceBody,
} from '../fixtures/lending';
import { customerBody } from '../fixtures/identity';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

describe('Lending rules', () => {
  let t: TestApp;
  let ngn: TestTenant;
  let other: TestTenant;
  let monthly: string;
  let alice: TestCustomer;
  let bob: TestCustomer;

  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const get = (path: string, token: string) => request(t.http).get(path).set(bearer(token));
  const apply = (token: string, body: Record<string, unknown>) =>
    request(t.http)
      .post('/v1/loan-applications')
      .set(bearer(token))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const assess = (tenant: TestTenant, id: string) =>
    request(t.http)
      .post(`/v1/loan-applications/${id}/assess`)
      .set(bearer(tenant.tokens.CREDIT_OFFICER));
  const approve = (tenant: TestTenant, id: string, body: object = {}) =>
    request(t.http)
      .post(`/v1/loan-applications/${id}/approve`)
      .set(bearer(tenant.tokens.CREDIT_OFFICER))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const monthlyBody = (overrides: Record<string, unknown> = {}) => ({
    productId: monthly,
    principal: '100000000',
    term: 6,
    payee: { name: 'Borrower', account: '0123456789' },
    ...overrides,
  });
  const runner = () => t.app.get(TransactionRunner);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-01-15T09:00:00Z');
    t = await createTestApp(LENDING_MODULES, LONG_LIVED_TOKENS);
    ngn = await createTestTenant(t.app, { maxAprBps: 6000 });
    other = await createTestTenant(t.app);
    monthly = await createProduct(t.http, ngn, ngnMonthlyTerms());
    alice = await registerScoredCustomer(t.http, ngn);
    bob = await registerScoredCustomer(t.http, ngn);
  });

  afterAll(async () => {
    await t.close();
    vi.useRealTimers();
  });

  describe('applications', () => {
    it('rejects an unverified customer, out-of-range amount and term', async () => {
      // A national id starting with 000 stays KYC PENDING in the mock provider.
      const pendingKyc = await request(t.http)
        .post(`/v1/institutions/${ngn.slug}/customers/register`)
        .send(customerBody({ nationalId: '00012345678' }))
        .expect(201);
      const res = await apply(pendingKyc.body.tokens.accessToken as string, monthlyBody()).expect(
        422,
      );
      expect(res.body.code).toBe('KYC_NOT_VERIFIED');

      expect(
        (await apply(alice.token, monthlyBody({ principal: '999999999' })).expect(422)).body.code,
      ).toBe('AMOUNT_OUT_OF_PRODUCT_RANGE');
      expect((await apply(alice.token, monthlyBody({ term: 2 })).expect(422)).body.code).toBe(
        'TERM_OUT_OF_PRODUCT_RANGE',
      );
      await request(t.http)
        .post('/v1/loan-applications')
        .set(bearer(alice.token))
        .send(monthlyBody())
        .expect(422); // no Idempotency-Key
      await apply(ngn.tokens.CREDIT_OFFICER, monthlyBody()).expect(400); // customerId required
      await apply(ngn.tokens.FINANCE_OFFICER, monthlyBody({ customerId: alice.id })).expect(403);
    });

    it('customers see only their own applications; withdraw is the owner’s', async () => {
      const mine = await apply(alice.token, monthlyBody()).expect(201);
      const id = mine.body.id as string;
      await get(`/v1/loan-applications/${id}`, bob.token).expect(404);
      const bobs = await get('/v1/loan-applications', bob.token).expect(200);
      expect(itemIds(bobs.body)).not.toContain(id);
      const staff = await get('/v1/loan-applications?status=SUBMITTED', ngn.tokens.AUDITOR).expect(
        200,
      );
      expect(itemIds(staff.body)).toContain(id);

      await request(t.http)
        .post(`/v1/loan-applications/${id}/withdraw`)
        .set(bearer(bob.token))
        .expect(404);
      await request(t.http)
        .post(`/v1/loan-applications/${id}/withdraw`)
        .set(bearer(ngn.tokens.CREDIT_OFFICER))
        .expect(403);
      const withdrawn = await request(t.http)
        .post(`/v1/loan-applications/${id}/withdraw`)
        .set(bearer(alice.token))
        .expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
      expect((await assess(ngn, id).expect(409)).body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('maker-checker: the submitting credit officer cannot decide', async () => {
      const res = await apply(ngn.tokens.CREDIT_OFFICER, monthlyBody({ customerId: alice.id }));
      expect(res.status).toBe(201);
      const id = res.body.id as string;
      await assess(ngn, id).expect(200);
      expect((await approve(ngn, id).expect(403)).body.code).toBe('SOD_VIOLATION');
      const reject = await request(t.http)
        .post(`/v1/loan-applications/${id}/reject`)
        .set(bearer(ngn.tokens.CREDIT_OFFICER))
        .send({ reasonCodes: ['R01_DTI_ABOVE_THRESHOLD'] })
        .expect(403);
      expect(reject.body.code).toBe('SOD_VIOLATION');
    });

    it('approval requires an assessment and cannot exceed the request', async () => {
      const id = (await apply(alice.token, monthlyBody()).expect(201)).body.id as string;
      expect((await approve(ngn, id).expect(422)).body.code).toBe('ASSESSMENT_REQUIRED');
      await assess(ngn, id).expect(200);
      expect(
        (await approve(ngn, id, { approvedPrincipal: '100000001' }).expect(422)).body.code,
      ).toBe('APPROVED_AMOUNT_EXCEEDS_REQUEST');
      const ok = await approve(ngn, id, { approvedPrincipal: '50000000' }).expect(201);
      // 2 % fee on the approved amount.
      expect(ok.body.loan).toMatchObject({
        approvedPrincipal: '50000000',
        netDisbursed: '49000000',
      });
    });

    it('decline path: delinquent bureau ⇒ DECLINE, approval refused, rejection recorded', async () => {
      const risky = await registerScoredCustomer(t.http, ngn, delinquentScore);
      const id = (await apply(risky.token, monthlyBody()).expect(201)).body.id as string;
      const assessed = await assess(ngn, id).expect(200);
      expect(assessed.body).toMatchObject({ decision: 'DECLINE', bureauDelinquent: true });
      expect(assessed.body.reasonCodes).toContain('R04_BUREAU_DELINQUENCY');
      expect((await approve(ngn, id).expect(422)).body.code).toBe('ASSESSMENT_DECLINED');
      const rejected = await request(t.http)
        .post(`/v1/loan-applications/${id}/reject`)
        .set(bearer(ngn.tokens.CREDIT_OFFICER))
        .send({ reasonCodes: ['R04_BUREAU_DELINQUENCY'], notes: 'Bureau arrears' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        rejectionReasonCodes: ['R04_BUREAU_DELINQUENCY'],
      });
    });

    it('counter-offer path: DTI breach ⇒ approve at most the affordable principal', async () => {
      // Income ₦300,000 (30,000,000 kobo): instalment 17,852,581 is 59.5 % > 40 %. Budget
      // 40 % × 30,000,000 = 12,000,000 ⇒ P = 12,000,000 × (1 − 1.02^−6) / 0.02 = 67,217,170.
      const stretched = await registerScoredCustomer(t.http, ngn, undefined, {
        monthlyIncome: '30000000',
      });
      const id = (await apply(stretched.token, monthlyBody()).expect(201)).body.id as string;
      const assessed = await assess(ngn, id).expect(200);
      expect(assessed.body).toMatchObject({
        decision: 'COUNTER_OFFER',
        maxAffordablePrincipal: '67217170',
        reasonCodes: ['R01_DTI_ABOVE_THRESHOLD'],
      });
      expect(
        (await approve(ngn, id, { approvedPrincipal: '67217171' }).expect(422)).body.code,
      ).toBe('APPROVED_AMOUNT_EXCEEDS_AFFORDABLE');
      const ok = await approve(ngn, id).expect(201);
      expect(ok.body.application.approvedPrincipal).toBe('67217170');
    });
  });

  describe('disbursement', () => {
    it('maker-checker: the approver cannot disburse', async () => {
      const { loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      // Simulate one person holding both duties (no seeded role has both permissions).
      await runner().runForTenant(ngn.tenantId, (tx) =>
        tx
          .updateTable('loans')
          .set({ approved_by: ngn.userIds.FINANCE_OFFICER })
          .where('id', '=', loanId)
          .execute(),
      );
      expect((await disburse(t.http, ngn, loanId).expect(403)).body.code).toBe('SOD_VIOLATION');
      await request(t.http)
        .post(`/v1/loans/${loanId}/disburse`)
        .set(bearer(ngn.tokens.CREDIT_OFFICER))
        .set('Idempotency-Key', idemKey())
        .expect(403);
    });

    it('provider failure leaves the loan pending with no postings', async () => {
      const { loanId } = await applyAndApprove(
        t.http,
        ngn,
        alice,
        monthlyBody({ payee: { name: 'Closed account', account: '0009998887' } }),
      );
      const res = await disburse(t.http, ngn, loanId).expect(502);
      expect(res.body.code).toBe('DISBURSEMENT_PROVIDER_FAILED');
      const loan = await get(`/v1/loans/${loanId}`, ngn.tokens.FINANCE_OFFICER).expect(200);
      expect(loan.body.status).toBe('PENDING_DISBURSEMENT');
      const ledger = await get(`/v1/loans/${loanId}/ledger`, ngn.tokens.FINANCE_OFFICER).expect(
        200,
      );
      expect(ledger.body.entries).toEqual([]);
    });

    it('lapsed approval: disbursement refused, EOD expires it and cancels the loan', async () => {
      at('2026-01-15T09:00:00Z');
      const { applicationId, loanId } = await applyAndApprove(t.http, ngn, bob, monthlyBody());
      at('2026-01-30T09:00:00Z'); // 15 days later; expiry is 14
      expect((await disburse(t.http, ngn, loanId).expect(422)).body.code).toBe(
        'APPLICATION_EXPIRED',
      );
      const eod = await runEndOfDay(t.http, ngn, '2026-01-30').expect(200);
      expect(eod.body.applicationsExpired).toBeGreaterThanOrEqual(1);
      const app = await get(`/v1/loan-applications/${applicationId}`, bob.token).expect(200);
      expect(app.body.status).toBe('EXPIRED');
      const loan = await get(`/v1/loans/${loanId}`, bob.token).expect(200);
      expect(loan.body).toMatchObject({ status: 'CANCELLED', approvedBy: null });
      at('2026-01-15T09:00:00Z');
    });

    it('EOD never expires an approval before its expires_at, even within its last day', async () => {
      at('2026-01-15T09:00:00Z');
      const { applicationId, loanId } = await applyAndApprove(t.http, ngn, bob, monthlyBody());
      const approved = await get(`/v1/loan-applications/${applicationId}`, bob.token).expect(200);
      expect(approved.body.expiresAt).toBe('2026-01-29T09:00:00.000Z');

      // 08:00 Lagos on the last day: EOD for that same date must not expire it yet.
      at('2026-01-29T07:00:00Z');
      await runEndOfDay(t.http, ngn, '2026-01-29').expect(200);
      expect(
        (await get(`/v1/loan-applications/${applicationId}`, bob.token).expect(200)).body.status,
      ).toBe('APPROVED');

      // Once expires_at has passed, the same run expires it.
      at('2026-01-29T09:00:01Z');
      await runEndOfDay(t.http, ngn, '2026-01-29').expect(200);
      expect(
        (await get(`/v1/loan-applications/${applicationId}`, bob.token).expect(200)).body.status,
      ).toBe('EXPIRED');
      expect((await get(`/v1/loans/${loanId}`, bob.token).expect(200)).body.status).toBe(
        'CANCELLED',
      );
      at('2026-01-15T09:00:00Z');
    });
  });

  describe('repayments', () => {
    it('two concurrent repayments never over-allocate (loan row lock)', async () => {
      at('2026-01-15T09:00:00Z');
      const { loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      await disburse(t.http, ngn, loanId).expect(200);
      // Payoff today: principal 100,000,000 (no interest due yet), so 2 × 60,000,000 > payoff.
      const results = await Promise.all([
        repay(t.http, ngn, loanId, '60000000'),
        repay(t.http, ngn, loanId, '60000000'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422)?.body.code).toBe('REPAYMENT_EXCEEDS_PAYOFF');
      const list = await get(`/v1/loans/${loanId}/repayments`, ngn.tokens.FINANCE_OFFICER).expect(
        200,
      );
      expect(list.body.items).toHaveLength(1);
      const quote = await get(`/v1/loans/${loanId}/payoff-quote`, alice.token).expect(200);
      // Oldest first: instalments 1–3 in full (3 × 17,852,581) then instalment 4 interest
      // 1,029,695 + principal 5,412,562. Principal paid 15,852,581 + 16,169,633 + 16,493,025
      // + 5,412,562 = 53,927,801 ⇒ 46,072,199 left, now the whole payoff (< 60,000,000).
      expect(quote.body).toMatchObject({ principal: '46072199', total: '46072199' });
    });

    it('a customer cannot see or touch another customer’s loan', async () => {
      const { loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      await get(`/v1/loans/${loanId}`, bob.token).expect(404);
      await get(`/v1/loans/${loanId}/schedule`, bob.token).expect(404);
      await get(`/v1/loans/${loanId}/repayments`, bob.token).expect(404);
      await request(t.http)
        .post(`/v1/loans/${loanId}/repayments`)
        .set(bearer(bob.token))
        .set('Idempotency-Key', idemKey())
        .send({ amount: '1000', channel: 'CARD' })
        .expect(403);
      await get(`/v1/loans/${loanId}/ledger`, alice.token).expect(403);
      const mine = await get('/v1/loans', bob.token).expect(200);
      expect(itemIds(mine.body)).not.toContain(loanId);
    });
  });

  describe('BULLET 30-day vendor-paid checkout loan', () => {
    it('pays the vendor, one instalment, repaid at maturity', async () => {
      at('2026-01-15T09:00:00Z');
      const bullet = await createProduct(
        t.http,
        ngn,
        ngnMonthlyTerms({
          minTerm: 14,
          maxTerm: 90,
          repaymentFrequency: 'BULLET',
          annualInterestRateBps: 3000,
          originationFee: { type: 'PERCENTAGE', value: '100', treatment: 'DEDUCTED' },
          disbursementMode: 'VENDOR',
        }),
      );
      const { loanId } = await applyAndApprove(t.http, ngn, bob, {
        productId: bullet,
        principal: '50000000',
        term: 30,
        // No payee: checkout financing pays the order's vendor (procurement platform).
        externalOrderReference: 'ORD-2026-000123',
      });
      const loan = await disburse(t.http, ngn, loanId).expect(200);
      // Interest 50,000,000 × 0.30 × 30/365 = 1,232,876.7 ⇒ 1,232,877; fee 1 % = 500,000.
      expect(loan.body).toMatchObject({
        payee: { type: 'VENDOR', name: 'Medisource Distributors Ltd' },
        netDisbursed: '49500000',
        maturityDate: '2026-02-14',
        outstanding: { principal: '50000000', interest: '1232877', total: '51232877' },
      });
      const events = await runner().runForTenant(ngn.tenantId, (tx) =>
        tx
          .selectFrom('outbox_events')
          .select('payload')
          .where('aggregate_id', '=', loanId)
          .where('event_type', '=', 'loan.disbursed')
          .executeTakeFirstOrThrow(),
      );
      expect(events.payload).toMatchObject({
        externalOrderReference: 'ORD-2026-000123',
        payee: { type: 'VENDOR', account: '0123456789' },
      });

      at('2026-02-14T09:00:00Z');
      const res = await repay(t.http, ngn, loanId, '51232877').expect(201);
      expect(res.body).toMatchObject({ settled: true, loanStatus: 'CLOSED', waivedInterest: '0' });
      at('2026-01-15T09:00:00Z');
    });
  });

  describe('end-of-day', () => {
    it('accrues due interest once; a re-run posts nothing', async () => {
      at('2026-01-15T09:00:00Z');
      const { loanId } = await applyAndApprove(t.http, ngn, bob, monthlyBody());
      await disburse(t.http, ngn, loanId).expect(200);
      at('2026-02-15T09:00:00Z');
      await runEndOfDay(t.http, ngn, '2026-02-15').expect(200);
      const countEntries = () =>
        runner().runForTenant(ngn.tenantId, (tx) =>
          tx
            .selectFrom('journal_entries')
            .select(['kind', 'idempotency_ref'])
            .where('loan_id', '=', loanId)
            .execute(),
        );
      const first = await countEntries();
      expect(first.map((e) => e.kind).sort()).toEqual(['DISBURSEMENT', 'INTEREST_ACCRUAL']);
      const again = await runEndOfDay(t.http, ngn, '2026-02-15').expect(200);
      expect(again.body.interestAccruals).toBe(0);
      expect(await countEntries()).toHaveLength(2);
      await runEndOfDay(t.http, ngn, '2026-02-15')
        .set(bearer(ngn.tokens.FINANCE_OFFICER))
        .expect(403);
      const tb = (await get('/v1/ledger/trial-balance', ngn.tokens.AUDITOR).expect(200))
        .body as TrialBalanceBody;
      expect(tb.balanced).toBe(true);
      at('2026-01-15T09:00:00Z');
    });
  });

  describe('XOF (no minor unit) under a WAEMU usury cap', () => {
    let xof: TestTenant;
    let customer: TestCustomer;
    const xofTerms = (overrides: Record<string, unknown> = {}) =>
      ngnMonthlyTerms({
        currency: 'XOF',
        minPrincipal: '10000',
        maxPrincipal: '5000000',
        annualInterestRateBps: 1500,
        originationFee: { type: 'PERCENTAGE', value: '100', treatment: 'CAPITALISED' },
        lateFee: { type: 'FLAT', value: '5000', graceDays: 3 },
        ...overrides,
      });

    beforeAll(async () => {
      at('2026-01-15T09:00:00Z');
      xof = await createTestTenant(t.app, {
        currency: 'XOF',
        lenderType: 'MICROFINANCE_INSTITUTION',
        maxAprBps: 2400,
      });
      customer = await registerScoredCustomer(t.http, xof, undefined, {
        currency: 'XOF',
        monthlyIncome: '2000000',
        monthlyExpenses: '500000',
      });
    });

    it('prices, disburses and repays in whole francs', async () => {
      const product = await createProduct(t.http, xof, xofTerms());
      const { loanId } = await applyAndApprove(t.http, xof, customer, {
        productId: product,
        principal: '1000000',
        term: 3,
        payee: { name: 'Pharmacie du Plateau', account: 'SN0123456789' },
      });
      const loan = await disburse(t.http, xof, loanId).expect(200);
      // Capitalised 1 % fee: financed 1,010,000; cash out 1,000,000. A = 1,010,000 × 0.0125 /
      // (1 − 1.0125^−3) = 345,118 (last 345,119); APR 21.09 % ≤ 24 % cap.
      expect(loan.body).toMatchObject({
        currency: 'XOF',
        financedPrincipal: '1010000',
        netDisbursed: '1000000',
        originationFee: '10000',
        aprBps: 2109,
        outstanding: { principal: '1010000', interest: '25355' },
      });
      const schedule = await get(`/v1/loans/${loanId}/schedule`, customer.token).expect(200);
      expect(
        (schedule.body.instalments as { principalDue: string; interestDue: string }[]).map((i) => [
          i.principalDue,
          i.interestDue,
        ]),
      ).toEqual([
        ['332493', '12625'],
        ['336649', '8469'],
        ['340858', '4261'],
      ]);
      const paid = await repay(t.http, xof, loanId, '345118').expect(201);
      expect(paid.body.allocation).toMatchObject({ interest: '12625', principal: '332493' });
      const tb = (
        await get('/v1/ledger/trial-balance?currency=XOF', xof.tokens.AUDITOR).expect(200)
      ).body as TrialBalanceBody;
      expect(tb.balanced).toBe(true);
      // Cash: −1,000,000 out + 345,118 in; principal receivable 1,010,000 − 332,493.
      expect(balances(tb)).toMatchObject({ '1000': '-654882', '1100': '677507', '4100': '10000' });
    });

    it('refuses an approval whose all-in APR exceeds the institution cap', async () => {
      // FLAT 23 % (below the 24 % cap) + 3 % deducted fee over 3 months ⇒ APR 53.35 %.
      // Such terms can no longer be CREATED under the cap (worst-case all-in APR check), so
      // the product predates the cap: created uncapped, then the regulator's cap applies.
      const setCap = (maxAprBps: number | null) =>
        t.app
          .get(TransactionRunner)
          .asPlatformAdmin((tx) =>
            tx
              .updateTable('institutions')
              .set({ max_apr_bps: maxAprBps })
              .where('id', '=', xof.tenantId)
              .execute(),
          );
      await setCap(null);
      const product = await createProduct(
        t.http,
        xof,
        xofTerms({
          interestMethod: 'FLAT',
          annualInterestRateBps: 2300,
          originationFee: { type: 'PERCENTAGE', value: '300', treatment: 'DEDUCTED' },
        }),
      ).finally(() => setCap(2400));
      const id = (
        await apply(customer.token, {
          productId: product,
          principal: '1000000',
          term: 3,
          payee: { name: 'Self', account: 'SN0123456789' },
        }).expect(201)
      ).body.id as string;
      await assess(xof, id).expect(200);
      const res = await approve(xof, id).expect(422);
      expect(res.body).toMatchObject({ code: 'APR_EXCEEDS_CAP', aprBps: 5335, maxAprBps: 2400 });
    });

    it('cannot apply for another tenant’s product', async () => {
      const id = await apply(customer.token, {
        productId: monthly,
        principal: '1000000',
        term: 3,
        payee: { name: 'Self', account: 'SN0123456789' },
      });
      expect(id.status).toBe(404);
    });
  });

  describe('repayment value dates and references', () => {
    const record = (loanId: string, body: Record<string, unknown>, tenant = ngn) =>
      request(t.http)
        .post(`/v1/loans/${loanId}/repayments`)
        .set(bearer(tenant.tokens.FINANCE_OFFICER))
        .set('Idempotency-Key', idemKey())
        .send({ channel: 'BANK_TRANSFER', externalReference: `NIP-${idemKey()}`, ...body });

    it('accepts only value dates in [latest repayment, today − window .. today]', async () => {
      at('2026-01-15T09:00:00Z');
      const { loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      await disburse(t.http, ngn, loanId).expect(200);
      at('2026-01-25T09:00:00Z');

      const tooOld = await record(loanId, { amount: '100000', valueDate: '2026-01-21' }).expect(
        422,
      );
      expect(tooOld.body).toMatchObject({
        code: 'VALUE_DATE_OUT_OF_RANGE',
        earliestValueDate: '2026-01-22',
        latestValueDate: '2026-01-25',
      });
      expect(
        (await record(loanId, { amount: '100000', valueDate: '2026-01-26' }).expect(422)).body.code,
      ).toBe('VALUE_DATE_OUT_OF_RANGE');
      // Malformed dates are still request validation (400).
      await record(loanId, { amount: '100000', valueDate: '25/01/2026' }).expect(400);

      await record(loanId, { amount: '100000', valueDate: '2026-01-23' }).expect(201);
      // Never before the latest recorded repayment (value-date order).
      const outOfOrder = await record(loanId, {
        amount: '100000',
        valueDate: '2026-01-22',
      }).expect(422);
      expect(outOfOrder.body).toMatchObject({
        code: 'VALUE_DATE_OUT_OF_RANGE',
        earliestValueDate: '2026-01-23',
      });
      await record(loanId, { amount: '100000', valueDate: '2026-01-23' }).expect(201);
      await record(loanId, { amount: '100000' }).expect(201);
      at('2026-01-15T09:00:00Z');
    });

    it('a backdated settlement of a delinquent loan cannot waive interest already due', async () => {
      at('2026-01-15T09:00:00Z');
      const { loanId } = await applyAndApprove(t.http, ngn, bob, monthlyBody());
      await disburse(t.http, ngn, loanId).expect(200);
      // Instalment 1 (interest 2,000,000) fell due on 15 Feb; EOD recognised it.
      at('2026-02-16T09:00:00Z');
      await runEndOfDay(t.http, ngn, '2026-02-16').expect(200);
      const loan = await get(`/v1/loans/${loanId}`, ngn.tokens.FINANCE_OFFICER).expect(200);
      expect(loan.body.daysPastDue).toBeGreaterThan(0);

      // Quoting (or settling) as of 14 Feb — the day BEFORE it fell due — still owes it.
      const today = (await get(`/v1/loans/${loanId}/payoff-quote`, bob.token).expect(200)).body;
      const backdated = (
        await get(`/v1/loans/${loanId}/payoff-quote?asOf=2026-02-14`, bob.token).expect(200)
      ).body;
      expect(today).toMatchObject({
        asOf: '2026-02-16',
        principal: '100000000',
        interest: '2000000',
      });
      expect(backdated).toEqual({ ...today, asOf: '2026-02-14' });

      // Settling with that value date pays the overdue interest; only instalments 2–6 are
      // waived (interest due after business today).
      const settled = await record(loanId, {
        amount: backdated.total as string,
        valueDate: '2026-02-14',
      }).expect(201);
      expect(settled.body).toMatchObject({
        settled: true,
        loanStatus: 'CLOSED',
        valueDate: '2026-02-14',
        waivedInterest: backdated.waivedInterest,
        allocation: { interest: '2000000', principal: '100000000' },
      });
      const entries = (
        await get(`/v1/loans/${loanId}/ledger`, ngn.tokens.FINANCE_OFFICER).expect(200)
      ).body.entries as { kind: string }[];
      // The recognised instalment-1 interest was collected, never reversed.
      expect(entries.map((e) => e.kind)).not.toContain('REVERSAL');
      const tb = (await get('/v1/ledger/trial-balance', ngn.tokens.AUDITOR).expect(200))
        .body as TrialBalanceBody;
      expect(tb.balanced).toBe(true);
      at('2026-01-15T09:00:00Z');
    });

    it('requires an external reference for every channel except CASH, once per institution', async () => {
      at('2026-01-15T09:00:00Z');
      const { loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      await disburse(t.http, ngn, loanId).expect(200);
      for (const channel of ['BANK_TRANSFER', 'CARD', 'DIRECT_DEBIT', 'MOBILE_MONEY']) {
        const res = await record(loanId, {
          amount: '100000',
          channel,
          externalReference: undefined,
        }).expect(422);
        expect(res.body).toMatchObject({ code: 'EXTERNAL_REFERENCE_REQUIRED', channel });
      }
      await record(loanId, {
        amount: '100000',
        channel: 'CASH',
        externalReference: undefined,
      }).expect(201);
      const reference = `NIP-${idemKey()}`;
      await record(loanId, { amount: '100000', externalReference: reference }).expect(201);
      const twice = await record(loanId, {
        amount: '100000',
        channel: 'CARD',
        externalReference: reference,
      }).expect(409);
      expect(twice.body.code).toBe('DUPLICATE');
    });
  });

  describe('payee rules', () => {
    let vendorProduct: string;

    beforeAll(async () => {
      at('2026-01-15T09:00:00Z');
      vendorProduct = await createProduct(
        t.http,
        ngn,
        ngnMonthlyTerms({ disbursementMode: 'VENDOR' }),
      );
    });

    const vendorBody = (overrides: Record<string, unknown> = {}) => ({
      productId: vendorProduct,
      principal: '50000000',
      term: 3,
      externalOrderReference: 'ORD-2026-000777',
      ...overrides,
    });

    it('checkout financing pays the order’s vendor, never a payee the borrower chose', async () => {
      const missing = await apply(alice.token, vendorBody({ externalOrderReference: undefined }));
      expect(missing.status).toBe(400);
      expect(missing.body.errors).toEqual([
        expect.objectContaining({ field: 'externalOrderReference' }),
      ]);
      const unknown = await apply(alice.token, vendorBody({ externalOrderReference: 'INV-1' }));
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('CHECKOUT_ORDER_NOT_FOUND');

      for (const payee of [
        { name: 'My cousin', account: '0555666777' },
        { type: 'VENDOR', name: 'Fake vendor', account: '0555666777' },
        { type: 'BORROWER', name: 'Me', account: '0123456789' },
      ]) {
        const res = await apply(alice.token, vendorBody({ payee }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('PAYEE_NOT_ALLOWED');
      }
      // Staff cannot redirect it either.
      const staff = await apply(
        ngn.tokens.CREDIT_OFFICER,
        vendorBody({ customerId: alice.id, payee: { name: 'X', account: '0555666777' } }),
      );
      expect(staff.body.code).toBe('PAYEE_NOT_ALLOWED');

      const ok = await apply(alice.token, vendorBody()).expect(201);
      expect(ok.body.payee).toEqual({
        type: 'VENDOR',
        name: 'Medisource Distributors Ltd',
        account: '0123456789',
      });
      // A payee that matches the order's vendor account is accepted; the name is the platform's.
      // (Another order: the first one now backs a live application.)
      const matching = await apply(
        alice.token,
        vendorBody({
          externalOrderReference: 'ORD-2026-000778',
          payee: { type: 'VENDOR', name: 'Whatever', account: '0123456789' },
        }),
      ).expect(201);
      expect(matching.body.payee.name).toBe('Medisource Distributors Ltd');
    });

    it('a customer can only name a payee of the product’s disbursement mode', async () => {
      const res = await apply(
        alice.token,
        monthlyBody({ payee: { type: 'VENDOR', name: 'Somebody', account: '0555666777' } }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'PAYEE_NOT_ALLOWED', disbursementMode: 'BORROWER' });
      const noPayee = await apply(alice.token, monthlyBody({ payee: undefined }));
      expect(noPayee.status).toBe(400);
      await apply(
        alice.token,
        monthlyBody({ payee: { type: 'BORROWER', name: 'Alice', account: '0123456789' } }),
      ).expect(201);
      // Staff may direct a borrower-mode loan to a vendor (an audited staff decision).
      const staff = await apply(
        ngn.tokens.CREDIT_OFFICER,
        monthlyBody({
          customerId: alice.id,
          payee: { type: 'VENDOR', name: 'Supplier', account: '0555666777' },
        }),
      ).expect(201);
      expect(staff.body.payee.type).toBe('VENDOR');
    });

    it('audits payee accounts masked to the last 4 characters', async () => {
      const { applicationId, loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      const rows = await runner().runForTenant(ngn.tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .select(['action', 'after_state'])
          .where('entity_id', 'in', [applicationId, loanId])
          .where('action', 'in', ['loan_application.submitted', 'loan.created'])
          .execute(),
      );
      expect(rows.map((r) => r.action).sort()).toEqual([
        'loan.created',
        'loan_application.submitted',
      ]);
      for (const row of rows) {
        expect(row.after_state).toMatchObject({ payee: { account: '****6789' } });
        expect(JSON.stringify(row.after_state)).not.toContain('0123456789');
      }
    });
  });

  describe('tenant isolation', () => {
    it('another tenant’s applications, loans and ledger are 404', async () => {
      const { applicationId, loanId } = await applyAndApprove(t.http, ngn, alice, monthlyBody());
      await get(`/v1/loan-applications/${applicationId}`, other.tokens.AUDITOR).expect(404);
      await assess(other, applicationId).expect(404);
      await get(`/v1/loans/${loanId}`, other.tokens.AUDITOR).expect(404);
      await get(`/v1/loans/${loanId}/ledger`, other.tokens.AUDITOR).expect(404);
      await disburse(t.http, other, loanId).expect(404);
      await repay(t.http, other, loanId, '1000').expect(404);
      const tb = (await get('/v1/ledger/trial-balance', other.tokens.AUDITOR).expect(200))
        .body as TrialBalanceBody;
      expect(tb.totalDebits).toBe('0');
    });
  });
});
