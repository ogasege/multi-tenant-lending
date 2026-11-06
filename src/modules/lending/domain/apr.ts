import type { RepaymentFrequency } from '../../../common/database/schema';
import { BusinessRuleError, ValidationError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { FinDecimal } from '../../../common/money/money';

import { daysBetween, type IsoDate } from './dates';
import { DAYS_PER_YEAR, PERIODS_PER_YEAR, roundMinor, toDecimal } from './schedule';

export interface AprCashFlow {
  /** Period index of the payment (1 = one unit period after disbursement). */
  seq: number;
  dueDate: IsoDate;
  /** Amount the borrower pays on `dueDate` (principal + interest + scheduled fees). */
  total: bigint;
}

export interface AprInput {
  /** Cash actually received by the borrower (or paid to the vendor on their behalf) at t0. */
  netDisbursed: bigint;
  disbursementDate: IsoDate;
  frequency: RepaymentFrequency;
  instalments: readonly AprCashFlow[];
}

const ONE = new FinDecimal(1);
const TOLERANCE = new FinDecimal('1e-24');
const MAX_ITERATIONS = 400;

/** A payment of `amount` (minor units) at `t` whole unit periods after the advance. */
export interface TimedFlow {
  t: number;
  amount: FinDecimal;
}

/** g(i) = Σ C_k (1 + i)^−t_k − N and its derivative g'(i) = −Σ t_k C_k (1 + i)^−t_k−1. */
function netPresentValue(
  advance: FinDecimal,
  flows: readonly TimedFlow[],
  i: FinDecimal,
): { value: FinDecimal; slope: FinDecimal } {
  const v = ONE.div(ONE.plus(i));
  let value = advance.neg();
  let slope = new FinDecimal(0);
  for (const { t, amount } of flows) {
    const discounted = amount.mul(v.pow(t));
    value = value.plus(discounted);
    slope = slope.minus(discounted.mul(t).mul(v));
  }
  return { value, slope };
}

/**
 * Solve Σ C_k (1 + i)^−t_k = N for the periodic rate i, where C_k > 0 are payments at
 * integer unit periods t_k and N > 0 is the amount advanced. The left side is strictly
 * decreasing in i on (−1, ∞), so the root is unique; a safeguarded Newton–Raphson
 * ("rtsafe") keeps every iterate inside a shrinking bisection bracket, falling back to
 * bisection whenever a Newton step would leave the bracket.
 */
export function solvePeriodicRate(advance: FinDecimal, flows: readonly TimedFlow[]): FinDecimal {
  let lo = new FinDecimal('-0.999999');
  let hi = new FinDecimal(1);
  while (netPresentValue(advance, flows, hi).value.gt(0)) {
    lo = hi;
    hi = hi.mul(2);
    if (hi.gt(1e9)) throw new ValidationError('APR does not converge (cash flows too large)');
  }
  const total = flows.reduce((acc, { amount }) => acc.plus(amount), new FinDecimal(0));
  const maxT = flows.reduce((acc, { t }) => Math.max(acc, t), 1);
  // Simple-interest starting guess spread over the longest term: (ΣC/N − 1) / maxT.
  let x = total.div(advance).minus(1).div(maxT);
  if (x.lte(lo) || x.gte(hi)) x = lo.plus(hi).div(2);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { value, slope } = netPresentValue(advance, flows, x);
    if (value.isZero()) return x;
    if (value.gt(0)) lo = x;
    else hi = x;
    let next = slope.isZero() ? lo.plus(hi).div(2) : x.minus(value.div(slope));
    if (next.lte(lo) || next.gte(hi)) next = lo.plus(hi).div(2);
    if (next.minus(x).abs().lt(TOLERANCE) || hi.minus(lo).lt(TOLERANCE)) return next;
    x = next;
  }
  return x;
}

/**
 * Annual percentage rate in integer basis points (SPEC §7.4), the US Regulation Z
 * (12 CFR 1026, Appendix J) actuarial method:
 *
 * 1. Borrower cash flows: +netDisbursed at t0, −instalment totals at their due dates.
 * 2. The unit period is the payment period; solve for the periodic IRR i with
 *    netDisbursed = Σ total_k / (1 + i)^k (instalment k is k unit periods after t0).
 * 3. APR = i × unit periods per year (12 / 26 / 52 / 365) — nominal, NOT compounded.
 *
 * BULLET (single advance, single payment): the unit period is the tenor itself, so
 * i = total / netDisbursed − 1 and APR = i × 365 / tenorDays (ACT/365F).
 *
 * The result is rounded half-even to whole basis points. Every cost the borrower pays
 * (interest, deducted fee, capitalised fee via a larger schedule) is therefore in the APR.
 */
export function computeAprBps(input: AprInput): number {
  if (input.netDisbursed <= 0n) {
    throw new ValidationError('Net disbursed must be positive', [
      { field: 'netDisbursed', message: 'must be > 0' },
    ]);
  }
  if (input.instalments.length === 0) {
    throw new ValidationError('At least one instalment is required for an APR');
  }
  const advance = toDecimal(input.netDisbursed);

  if (input.frequency === 'BULLET') {
    const [only, ...rest] = input.instalments;
    if (!only || rest.length > 0) {
      throw new ValidationError('A BULLET schedule has exactly one instalment');
    }
    const days = daysBetween(input.disbursementDate, only.dueDate);
    if (days <= 0) throw new ValidationError('BULLET due date must be after disbursement');
    const periodic = toDecimal(only.total).div(advance).minus(1);
    return Number(roundMinor(periodic.mul(DAYS_PER_YEAR).div(days).mul(10_000)));
  }

  const flows = input.instalments.map((row) => {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new ValidationError('Instalment seq must be a positive integer');
    }
    return { t: row.seq, amount: toDecimal(row.total) };
  });
  const periodic = solvePeriodicRate(advance, flows);
  return Number(roundMinor(periodic.mul(PERIODS_PER_YEAR[input.frequency]).mul(10_000)));
}

/** Total cost of credit (FCCPC-style disclosure): totalRepayable − netDisbursed. */
export function totalCostOfCredit(totalRepayable: bigint, netDisbursed: bigint): bigint {
  return totalRepayable - netDisbursed;
}

/**
 * Enforce a regulatory / product APR ceiling: throws `BusinessRuleError` APR_EXCEEDS_CAP when
 * `aprBps > maxAprBps`. A `null` cap means the lender's licence imposes none.
 */
export function assertWithinAprCap(aprBps: number, maxAprBps: number | null): void {
  if (maxAprBps !== null && aprBps > maxAprBps) {
    throw new BusinessRuleError(
      ErrorCode.APR_EXCEEDS_CAP,
      `APR ${aprBps} bps exceeds the cap of ${maxAprBps} bps`,
      { aprBps, maxAprBps },
    );
  }
}
