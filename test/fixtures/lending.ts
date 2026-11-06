import { randomUUID } from 'node:crypto';

import request from 'supertest';
import type { App } from 'supertest/types';
import { inject } from 'vitest';

import { nationalIdHmac } from '@/common/crypto/crypto';
import { AuditModule } from '@/modules/audit/audit.module';
import { LedgerModule } from '@/modules/ledger/ledger.module';
import { MockCreditBureau } from '@/modules/lending/domain';
import { LendingModule } from '@/modules/lending/lending.module';
import { LoanProductsModule } from '@/modules/loan-products/loan-products.module';
import { OperationsModule } from '@/modules/operations/operations.module';

import { customerBody, type RegistrationBody } from './identity';
import type { TestTenant } from './tenants';

/** Feature modules of objectives 3–4, until they are registered in AppModule. */
export const LENDING_MODULES = [
  LoanProductsModule,
  LedgerModule,
  LendingModule,
  OperationsModule,
  AuditModule,
];

/** Tokens valid for a year, so tests can move the (faked) clock across months. */
export const LONG_LIVED_TOKENS = { JWT_ACCESS_TTL_SECONDS: '31536000' };

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idemKey = () => `k-${randomUUID()}`;

/**
 * An 11-digit national id whose mock-bureau score satisfies `accept`. The bureau score is a
 * keyed function of the stored national-id HMAC (per-tenant key derived from BVN_HMAC_KEY),
 * and the key is random per test run, so ids are searched rather than hard-coded.
 */
export function nationalIdWithScore(accept: (score: number) => boolean, tenantId: string): string {
  const key = inject('env').BVN_HMAC_KEY ?? '';
  const bureau = new MockCreditBureau(key);
  for (let i = 0; i < 100_000; i++) {
    const id = `5${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, '0')}`;
    if (accept(bureau.reportFor(nationalIdHmac(key, tenantId, id)).score)) return id;
  }
  throw new Error('No national id found for the requested score');
}

/** Bureau score that the product rules approve (not delinquent: ≥ 450). */
export const goodScore = (s: number) => s >= 720;
/** Bureau-delinquent score (< 450) ⇒ R04 knock-out ⇒ DECLINE. */
export const delinquentScore = (s: number) => s < 450;

export interface TestCustomer {
  id: string;
  token: string;
}

/** Self-registers a customer with a national id meeting `score` (KYC VERIFIED). */
export async function registerScoredCustomer(
  http: App,
  tenant: TestTenant,
  score: (s: number) => boolean = goodScore,
  overrides: Record<string, unknown> = {},
): Promise<TestCustomer> {
  const res = await request(http)
    .post(`/v1/institutions/${tenant.slug}/customers/register`)
    .send(customerBody({ nationalId: nationalIdWithScore(score, tenant.tenantId), ...overrides }))
    .expect(201);
  const body = res.body as RegistrationBody;
  return { id: body.customer.id, token: body.tokens.accessToken };
}

export const ngnMonthlyTerms = (overrides: Record<string, unknown> = {}) => ({
  currency: 'NGN',
  minPrincipal: '1000000',
  maxPrincipal: '500000000',
  minTerm: 3,
  maxTerm: 24,
  repaymentFrequency: 'MONTHLY',
  interestMethod: 'REDUCING_BALANCE',
  annualInterestRateBps: 2400,
  originationFee: { type: 'PERCENTAGE', value: '200', treatment: 'DEDUCTED' },
  lateFee: { type: 'FLAT', value: '500000', graceDays: 3 },
  maxDtiBps: 4000,
  minCreditScore: 0,
  applicationExpiryDays: 14,
  disbursementMode: 'BORROWER',
  ...overrides,
});

/** Creates an ACTIVE product as the institution admin; returns its id. */
export async function createProduct(
  http: App,
  tenant: TestTenant,
  terms: Record<string, unknown>,
): Promise<string> {
  const res = await request(http)
    .post('/v1/loan-products')
    .set(bearer(tenant.tokens.INSTITUTION_ADMIN))
    .send({ code: `P${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Product', terms })
    .expect(201);
  return (res.body as { id: string }).id;
}

export interface Journey {
  applicationId: string;
  loanId: string;
}

/** Customer applies, credit officer assesses and approves; returns application + loan ids. */
export async function applyAndApprove(
  http: App,
  tenant: TestTenant,
  customer: TestCustomer,
  body: Record<string, unknown>,
): Promise<Journey> {
  const app = await request(http)
    .post('/v1/loan-applications')
    .set(bearer(customer.token))
    .set('Idempotency-Key', idemKey())
    .send(body)
    .expect(201);
  const applicationId = (app.body as { id: string }).id;
  await request(http)
    .post(`/v1/loan-applications/${applicationId}/assess`)
    .set(bearer(tenant.tokens.CREDIT_OFFICER))
    .expect(200);
  const approved = await request(http)
    .post(`/v1/loan-applications/${applicationId}/approve`)
    .set(bearer(tenant.tokens.CREDIT_OFFICER))
    .set('Idempotency-Key', idemKey())
    .send({})
    .expect(201);
  return { applicationId, loanId: (approved.body as { loan: { id: string } }).loan.id };
}

export function disburse(http: App, tenant: TestTenant, loanId: string, key = idemKey()) {
  return request(http)
    .post(`/v1/loans/${loanId}/disburse`)
    .set(bearer(tenant.tokens.FINANCE_OFFICER))
    .set('Idempotency-Key', key);
}

/** Records a bank-transfer repayment (with a unique statement reference) as finance. */
export function repay(
  http: App,
  tenant: TestTenant,
  loanId: string,
  amount: string,
  key = idemKey(),
) {
  return request(http)
    .post(`/v1/loans/${loanId}/repayments`)
    .set(bearer(tenant.tokens.FINANCE_OFFICER))
    .set('Idempotency-Key', key)
    .send({ amount, channel: 'BANK_TRANSFER', externalReference: `NIP-${randomUUID()}` });
}

export function runEndOfDay(http: App, tenant: TestTenant, asOf: string) {
  return request(http)
    .post('/v1/operations/end-of-day')
    .set(bearer(tenant.tokens.INSTITUTION_ADMIN))
    .send({ asOf });
}

export interface TrialBalanceBody {
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  accounts: { code: string; debits: string; credits: string; balance: string }[];
}

/** Balance per account code of a trial balance. */
export const balances = (tb: TrialBalanceBody): Record<string, string> =>
  Object.fromEntries(tb.accounts.map((a) => [a.code, a.balance]));

/** Ids of a list page body. */
export const itemIds = (body: unknown): string[] =>
  (body as { items: { id: string }[] }).items.map((i) => i.id);
