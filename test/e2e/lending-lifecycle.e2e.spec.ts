import request from 'supertest';

import { TransactionRunner } from '@/common/database/transaction-runner';

import {
  balances,
  bearer,
  createProduct,
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
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

interface InstalmentBody {
  seq: number;
  dueDate: string;
  principalDue: string;
  interestDue: string;
  penaltyDue: string;
  principalPaid: string;
  interestPaid: string;
  penaltyPaid: string;
  interestWaived: string;
  status: string;
}

/**
 * Full lifecycle of a ₦1,000,000 (100,000,000 kobo) 6-month REDUCING_BALANCE loan at 24 % p.a.
 * with a 2 % deducted origination fee, disbursed 2026-01-15 (Lagos).
 *
 * Schedule (r = 0.24 / 12 = 0.02): A = P·r / (1 − 1.02^−6) = 100,000,000 × 0.1785258
 * = 17,852,581.2 ⇒ 17,852,581 per month; instalment 1 = 2,000,000 interest (1e8 × 0.02) +
 * 15,852,581 principal; the last instalment absorbs the rounding (17,852,583).
 * Fee F = 2 % × 100,000,000 = 2,000,000 ⇒ net disbursed 98,000,000.
 */
describe('Lending lifecycle (apply → assess → approve → disburse → repay → EOD → payoff)', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let customer: TestCustomer;
  let productId: string;
  let loanId: string;
  let applicationId: string;

  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const get = (path: string, token = tenant.tokens.FINANCE_OFFICER) =>
    request(t.http).get(path).set(bearer(token));
  const instalments = async () =>
    (await get(`/v1/loans/${loanId}/schedule`).expect(200)).body.instalments as InstalmentBody[];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-01-15T09:00:00Z');
    t = await createTestApp(LENDING_MODULES, LONG_LIVED_TOKENS);
    tenant = await createTestTenant(t.app, { maxAprBps: 6000 });
    customer = await registerScoredCustomer(t.http, tenant);
    productId = await createProduct(t.http, tenant, ngnMonthlyTerms());
  });

  afterAll(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('customer applies; credit officer assesses with an FCCPC disclosure', async () => {
    const app = await request(t.http)
      .post('/v1/loan-applications')
      .set(bearer(customer.token))
      .set('Idempotency-Key', idemKey())
      .send({
        productId,
        principal: '100000000',
        term: 6,
        purpose: 'Pharmacy restock',
        payee: { name: 'Amaka Eze', account: '0123456789' },
      })
      .expect(201);
    applicationId = app.body.id as string;
    expect(app.body).toMatchObject({
      reference: expect.stringMatching(/^APP-[A-Z0-9]{6}$/),
      status: 'SUBMITTED',
      customerId: customer.id,
      requestedPrincipal: '100000000',
      payee: { type: 'BORROWER', name: 'Amaka Eze', account: '0123456789' },
      // Borrower view: no staff/internal fields.
      submittedBy: null,
    });

    const assessed = await request(t.http)
      .post(`/v1/loan-applications/${applicationId}/assess`)
      .set(bearer(tenant.tokens.CREDIT_OFFICER))
      .expect(200);
    // Monthly instalment 17,852,581 / income 150,000,000 = 1,190.2 bps.
    expect(assessed.body).toMatchObject({
      modelVersion: 'scorecard-v1',
      decision: 'APPROVE',
      grade: 'A',
      dtiBps: 1190,
      instalmentAmount: '17852581',
      disclosure: {
        principal: '100000000',
        originationFee: '2000000',
        netDisbursed: '98000000',
        numberOfInstalments: 6,
        instalmentAmount: '17852581',
        totalInterest: '7115488',
        totalRepayable: '107115488',
        // 107,115,488 − 98,000,000
        totalCostOfCredit: '9115488',
        aprBps: 3122,
      },
    });

    const mine = await get(`/v1/loan-applications/${applicationId}`, customer.token).expect(200);
    expect(mine.body).toMatchObject({ status: 'ASSESSED', latestAssessment: { grade: null } });
  });

  it('credit officer approves: loan PENDING_DISBURSEMENT with frozen terms', async () => {
    const res = await request(t.http)
      .post(`/v1/loan-applications/${applicationId}/approve`)
      .set(bearer(tenant.tokens.CREDIT_OFFICER))
      .set('Idempotency-Key', idemKey())
      .send({ notes: 'Strong file' })
      .expect(201);
    loanId = res.body.loan.id as string;
    expect(res.body.application).toMatchObject({
      status: 'APPROVED',
      approvedPrincipal: '100000000',
      decidedBy: tenant.userIds.CREDIT_OFFICER,
      expiresAt: '2026-01-29T09:00:00.000Z',
      loanId,
    });
    expect(res.body.loan).toMatchObject({
      status: 'PENDING_DISBURSEMENT',
      financedPrincipal: '100000000',
      originationFee: '2000000',
      netDisbursed: '98000000',
      aprBps: 3122,
      terms: { annualInterestRateBps: 2400, term: 6, originationFee: { value: '200' } },
    });
    const preview = await get(`/v1/loans/${loanId}/schedule`).expect(200);
    expect(preview.body).toMatchObject({ preview: true, maturityDate: '2026-07-15' });
  });

  it('finance officer disburses: schedule from today, DISBURSEMENT posted once', async () => {
    const key = idemKey();
    const res = await disburse(t.http, tenant, loanId, key).expect(200);
    expect(res.body).toMatchObject({
      status: 'ACTIVE',
      disbursementDate: '2026-01-15',
      maturityDate: '2026-07-15',
      providerReference: expect.stringMatching(/^MOCK-/),
      outstanding: { principal: '100000000', interest: '7115488', total: '107115488' },
    });
    // Replay with the same key: same body, nothing posted twice.
    const replay = await disburse(t.http, tenant, loanId, key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(res.body);
    // A new key is a new request: the loan is already ACTIVE.
    await disburse(t.http, tenant, loanId).expect(409);

    const ledger = await get(`/v1/loans/${loanId}/ledger`).expect(200);
    expect(ledger.body.entries).toHaveLength(1);
    expect(ledger.body.entries[0]).toMatchObject({
      kind: 'DISBURSEMENT',
      idempotencyRef: `disbursement:${loanId}`,
      postings: expect.arrayContaining([
        {
          accountCode: '1100',
          accountName: 'Loan Principal Receivable',
          direction: 'DEBIT',
          amount: '100000000',
        },
        {
          accountCode: '1000',
          accountName: 'Settlement / Cash',
          direction: 'CREDIT',
          amount: '98000000',
        },
        { accountCode: '4100', accountName: 'Fee Income', direction: 'CREDIT', amount: '2000000' },
      ]),
    });

    const rows = await instalments();
    expect(rows.map((r) => [r.dueDate, r.principalDue, r.interestDue])).toEqual([
      ['2026-02-15', '15852581', '2000000'],
      ['2026-03-15', '16169633', '1682948'],
      ['2026-04-15', '16493025', '1359556'],
      ['2026-05-15', '16822886', '1029695'],
      ['2026-06-15', '17159343', '693238'],
      ['2026-07-15', '17502532', '350051'],
    ]);

    const events = await t.app
      .get(TransactionRunner)
      .runForTenant(tenant.tenantId, (tx) =>
        tx
          .selectFrom('outbox_events')
          .select('payload')
          .where('aggregate_id', '=', loanId)
          .where('event_type', '=', 'loan.disbursed')
          .execute(),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      netDisbursed: '98000000',
      payee: { type: 'BORROWER', account: '0123456789' },
    });
  });

  it('a customer cannot record a repayment (self-attested money-in)', async () => {
    await request(t.http)
      .post(`/v1/loans/${loanId}/repayments`)
      .set(bearer(customer.token))
      .set('Idempotency-Key', idemKey())
      .send({ amount: '1000', channel: 'CARD' })
      .expect(403);
  });

  it('partial repayment before the due date pays interest (recognised early) then principal', async () => {
    at('2026-02-10T09:00:00Z');
    const res = await repay(t.http, tenant, loanId, '10000000').expect(201);
    // Waterfall on instalment 1: interest 2,000,000, then principal 8,000,000.
    expect(res.body).toMatchObject({
      amount: '10000000',
      valueDate: '2026-02-10',
      allocation: { penalty: '0', fee: '0', interest: '2000000', principal: '8000000' },
      settled: false,
      loanStatus: 'ACTIVE',
    });
    const [first] = await instalments();
    expect(first).toMatchObject({
      interestPaid: '2000000',
      principalPaid: '8000000',
      status: 'PARTIALLY_PAID',
    });
  });

  it('EOD after the grace period charges the late fee once and sets DPD', async () => {
    at('2026-02-20T21:00:00Z');
    await runEndOfDay(t.http, tenant, '2026-02-21').expect(400); // future business date
    const first = await runEndOfDay(t.http, tenant, '2026-02-20').expect(200);
    expect(first.body).toMatchObject({
      asOf: '2026-02-20',
      loansProcessed: 1,
      interestAccruals: 0, // already recognised by the early payment
      lateFees: 1,
      delinquencyUpdates: 1,
    });
    const again = await runEndOfDay(t.http, tenant, '2026-02-20').expect(200);
    expect(again.body).toMatchObject({ loansProcessed: 1, lateFees: 0, interestAccruals: 0 });

    const [inst1] = await instalments();
    expect(inst1).toMatchObject({ penaltyDue: '500000', status: 'PARTIALLY_PAID' });
    const loan = await get(`/v1/loans/${loanId}`).expect(200);
    expect(loan.body).toMatchObject({ daysPastDue: 5, dpdBucket: 'DPD_1_30' });
    const overdue = await get('/v1/loans?dpdBucket=DPD_1_30').expect(200);
    expect(itemIds(overdue.body)).toContain(loanId);

    const entries = (await get(`/v1/loans/${loanId}/ledger`).expect(200)).body.entries as {
      kind: string;
      effectiveDate: string;
    }[];
    // Business order: the early payment recognises instalment 1 interest on its value date.
    expect(entries.map((e) => [e.effectiveDate, e.kind])).toEqual([
      ['2026-01-15', 'DISBURSEMENT'],
      ['2026-02-10', 'INTEREST_ACCRUAL'],
      ['2026-02-10', 'REPAYMENT'],
      ['2026-02-20', 'LATE_FEE'],
    ]);
  });

  it('payoff settles: future interest waived, loan CLOSED, books balance', async () => {
    const quote = await get(`/v1/loans/${loanId}/payoff-quote`, customer.token).expect(200);
    // Principal 100,000,000 − 8,000,000 + penalty 500,000; interest of instalments 2–6 waived.
    expect(quote.body).toMatchObject({
      asOf: '2026-02-20',
      principal: '92000000',
      interest: '0',
      penalties: '500000',
      total: '92500000',
      waivedInterest: '5115488',
    });
    await repay(t.http, tenant, loanId, '92500001').expect(422);

    const res = await repay(t.http, tenant, loanId, '92500000').expect(201);
    expect(res.body).toMatchObject({
      settled: true,
      loanStatus: 'CLOSED',
      waivedInterest: '5115488',
      allocation: { penalty: '500000', interest: '0', principal: '92000000' },
      outstanding: { total: '0' },
    });
    const rows = await instalments();
    expect(rows.every((r) => r.status === 'PAID')).toBe(true);
    expect(rows[1]).toMatchObject({ interestWaived: '1682948', interestPaid: '0' });
    await repay(t.http, tenant, loanId, '1').expect(409);

    const tb = (await get('/v1/ledger/trial-balance').expect(200)).body as TrialBalanceBody;
    // Dr: 100m + 2m + 10m + 0.5m + 92.5m = 205,000,000 on each side.
    expect(tb).toMatchObject({
      balanced: true,
      totalDebits: '205000000',
      totalCredits: '205000000',
    });
    expect(balances(tb)).toMatchObject({
      '1000': '4500000', // 102,500,000 collected − 98,000,000 paid out
      '1100': '0',
      '1110': '0',
      '1130': '0',
      '4000': '2000000',
      '4100': '2000000',
      '4200': '500000',
    });

    const repayments = await get(`/v1/loans/${loanId}/repayments`, customer.token).expect(200);
    expect(repayments.body.items).toHaveLength(2);
    expect(repayments.body.items[0].recordedBy).toBeNull();
  });

  it('audit trail is complete and the hash chain verifies', async () => {
    const verify = await get('/v1/audit-logs/verify', tenant.tokens.AUDITOR).expect(200);
    expect(verify.body).toMatchObject({ valid: true });
    expect(verify.body.entriesChecked).toBeGreaterThan(8);

    const page = await get(
      `/v1/audit-logs?entityId=${loanId}&limit=2`,
      tenant.tokens.AUDITOR,
    ).expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.items[0].action).toBe('loan.closed');
    const next = await get(
      `/v1/audit-logs?entityId=${loanId}&limit=100&cursor=${page.body.nextCursor as string}`,
      tenant.tokens.AUDITOR,
    ).expect(200);
    const actions = (next.body.items as { action: string }[]).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['loan.disbursed', 'loan.created']));
    await get('/v1/audit-logs', tenant.tokens.CREDIT_OFFICER).expect(403);
  });
});
