import { ACCOUNT, type AccountCode } from '../chart-of-accounts';

import type { JournalLine } from './journal';

/**
 * Posting rules (SPEC §8). Pure functions from a business event to balanced journal lines;
 * zero-amount lines are dropped so a rule never produces a posting the database would reject
 * (`postings.amount > 0`).
 */

const debit = (account: AccountCode, amount: bigint): JournalLine => ({
  account,
  direction: 'DEBIT',
  amount,
});
const credit = (account: AccountCode, amount: bigint): JournalLine => ({
  account,
  direction: 'CREDIT',
  amount,
});
const nonZero = (lines: JournalLine[]): JournalLine[] => lines.filter((l) => l.amount > 0n);

export interface DisbursementAmounts {
  /** Principal the schedule amortises (approved + capitalised fee). */
  financedPrincipal: bigint;
  /** Cash paid out to the payee. */
  netDisbursed: bigint;
  originationFee: bigint;
}

/**
 * Disbursement. The receivable is always the financed principal; the fee is earned up front.
 *
 * - DEDUCTED fee F on principal P: Dr 1100 P / Cr 1000 P − F / Cr 4100 F.
 * - CAPITALISED fee F on principal P: Dr 1100 P + F / Cr 1000 P / Cr 4100 F.
 *
 * Both reduce to Dr 1100 financed / Cr 1000 net / Cr 4100 fee, which is what is posted.
 */
export function disbursementLines(a: DisbursementAmounts): JournalLine[] {
  return nonZero([
    debit(ACCOUNT.LOAN_PRINCIPAL_RECEIVABLE, a.financedPrincipal),
    credit(ACCOUNT.CASH, a.netDisbursed),
    credit(ACCOUNT.FEE_INCOME, a.originationFee),
  ]);
}

/** Interest recognised (EOD on the due date, or on early payment): Dr 1110 / Cr 4000. */
export function interestAccrualLines(interest: bigint): JournalLine[] {
  return nonZero([
    debit(ACCOUNT.INTEREST_RECEIVABLE, interest),
    credit(ACCOUNT.INTEREST_INCOME, interest),
  ]);
}

/**
 * Reversal of recognised interest that is later waived (early settlement of an instalment
 * whose interest was already accrued): Dr 4000 / Cr 1110.
 */
export function interestWaiverLines(waived: bigint): JournalLine[] {
  return nonZero([
    debit(ACCOUNT.INTEREST_INCOME, waived),
    credit(ACCOUNT.INTEREST_RECEIVABLE, waived),
  ]);
}

/** Late fee assessed by EOD: Dr 1130 / Cr 4200. */
export function lateFeeLines(fee: bigint): JournalLine[] {
  return nonZero([debit(ACCOUNT.PENALTY_RECEIVABLE, fee), credit(ACCOUNT.PENALTY_INCOME, fee)]);
}

export interface RepaymentAllocationTotals {
  penalty: bigint;
  fee: bigint;
  interest: bigint;
  principal: bigint;
}

/**
 * Repayment of X allocated by the waterfall: Dr 1000 X / Cr 1130 penalty, 1120 fee,
 * 1110 interest, 1100 principal. Balanced by construction when X = Σ allocation.
 */
export function repaymentLines(allocation: RepaymentAllocationTotals): JournalLine[] {
  const total = allocation.penalty + allocation.fee + allocation.interest + allocation.principal;
  return nonZero([
    debit(ACCOUNT.CASH, total),
    credit(ACCOUNT.PENALTY_RECEIVABLE, allocation.penalty),
    credit(ACCOUNT.FEE_RECEIVABLE, allocation.fee),
    credit(ACCOUNT.INTEREST_RECEIVABLE, allocation.interest),
    credit(ACCOUNT.LOAN_PRINCIPAL_RECEIVABLE, allocation.principal),
  ]);
}
