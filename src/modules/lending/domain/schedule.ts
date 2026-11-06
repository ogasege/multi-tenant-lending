import Decimal from 'decimal.js';

import type { InterestMethod, RepaymentFrequency } from '../../../common/database/schema';
import { ValidationError } from '../../../common/errors/app-error';
import type { CurrencyCode } from '../../../common/money/currency';
import { FinDecimal } from '../../../common/money/money';

import { addDays, addMonths, assertIsoDate, type IsoDate } from './dates';

/** Instalment frequencies (everything except a single-payment BULLET). */
export type PeriodicFrequency = Exclude<RepaymentFrequency, 'BULLET'>;

/** Payment periods per year. Day count ACT/365F, so a "day" period is 1/365 of a year. */
export const PERIODS_PER_YEAR: Readonly<Record<PeriodicFrequency, number>> = {
  DAILY: 365,
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
};

/** ACT/365F: the year fraction of `d` days is d / 365. */
export const DAYS_PER_YEAR = 365;

const DAYS_PER_PERIOD: Readonly<Record<Exclude<PeriodicFrequency, 'MONTHLY'>, number>> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 14,
};

export interface ScheduleInput {
  /** Financed principal in minor units (after any capitalised fee). */
  principal: bigint;
  currency: CurrencyCode;
  /** Nominal annual rate in basis points (2400 = 24.00 % p.a.). */
  annualRateBps: number;
  /** Instalment count, or tenor in DAYS when `frequency` is BULLET. */
  term: number;
  frequency: RepaymentFrequency;
  /** Ignored for BULLET (single payment of principal + simple interest). */
  method: InterestMethod;
  disbursementDate: IsoDate;
}

export interface ScheduledInstalment {
  seq: number;
  dueDate: IsoDate;
  principal: bigint;
  interest: bigint;
  total: bigint;
}

export interface Schedule {
  currency: CurrencyCode;
  instalments: ScheduledInstalment[];
  totalPrincipal: bigint;
  totalInterest: bigint;
  totalRepayable: bigint;
  maturityDate: IsoDate;
}

/** A minor-unit amount as an arbitrary-precision decimal (inverse of {@link roundMinor}). */
export function toDecimal(minor: bigint): FinDecimal {
  return new FinDecimal(minor.toString());
}

/** Round an arbitrary-precision minor-unit amount to whole minor units, half-even. */
export function roundMinor(value: Decimal.Value): bigint {
  return BigInt(new FinDecimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
}

/** Annual rate as a decimal fraction: bps / 10 000. */
export function annualRate(annualRateBps: number): FinDecimal {
  return new FinDecimal(annualRateBps).div(10_000);
}

/** Periodic rate r = annualRate / periodsPerYear (SPEC §7.3). */
export function periodicRate(annualRateBps: number, frequency: PeriodicFrequency): FinDecimal {
  return annualRate(annualRateBps).div(PERIODS_PER_YEAR[frequency]);
}

/**
 * Level annuity payment `A = P·r / (1 − (1 + r)^−n)`; with r = 0 it degenerates to P / n.
 * Returned unrounded (minor units) so callers decide where to round.
 */
export function annuityPayment(principal: FinDecimal, rate: FinDecimal, n: number): FinDecimal {
  if (rate.isZero()) return principal.div(n);
  return principal.mul(rate).div(new FinDecimal(1).minus(rate.plus(1).pow(-n)));
}

/**
 * Inverse annuity: the principal a level payment `A` amortises over n periods,
 * `P = A · (1 − (1 + r)^−n) / r` (r = 0 ⇒ A · n). Unrounded.
 */
export function annuityPresentValue(payment: FinDecimal, rate: FinDecimal, n: number): FinDecimal {
  if (rate.isZero()) return payment.mul(n);
  return payment.mul(new FinDecimal(1).minus(rate.plus(1).pow(-n))).div(rate);
}

/** Due date of instalment `seq` (1-based): disbursement + seq periods, monthly EOM-clamped. */
export function dueDateFor(
  disbursementDate: IsoDate,
  frequency: PeriodicFrequency,
  seq: number,
): IsoDate {
  return frequency === 'MONTHLY'
    ? addMonths(disbursementDate, seq)
    : addDays(disbursementDate, DAYS_PER_PERIOD[frequency] * seq);
}

function validate(input: ScheduleInput): void {
  const errors: { field: string; message: string }[] = [];
  if (input.principal <= 0n) errors.push({ field: 'principal', message: 'must be > 0' });
  if (!Number.isSafeInteger(input.annualRateBps) || input.annualRateBps < 0) {
    errors.push({ field: 'annualRateBps', message: 'must be a non-negative integer' });
  }
  if (!Number.isSafeInteger(input.term) || input.term < 1) {
    errors.push({ field: 'term', message: 'must be a positive integer' });
  }
  if (errors.length > 0) throw new ValidationError('Invalid schedule input', errors);
  assertIsoDate(input.disbursementDate);
}

function instalment(
  seq: number,
  dueDate: IsoDate,
  principal: bigint,
  interest: bigint,
): ScheduledInstalment {
  return { seq, dueDate, principal, interest, total: principal + interest };
}

/**
 * BULLET (inventory finance): one instalment at disbursement + `term` days carrying the
 * whole principal and ACT/365F simple interest `I = P × rate × days / 365`.
 */
function bulletSchedule(input: ScheduleInput): ScheduledInstalment[] {
  const interest = roundMinor(
    toDecimal(input.principal)
      .mul(annualRate(input.annualRateBps))
      .mul(input.term)
      .div(DAYS_PER_YEAR),
  );
  return [instalment(1, addDays(input.disbursementDate, input.term), input.principal, interest)];
}

/**
 * REDUCING_BALANCE: level annuity A (rounded half-even once), interest each period on the
 * outstanding balance (rounded half-even), principal = A − interest, capped at the balance;
 * the final instalment clears the remaining balance exactly.
 */
function reducingBalance(
  input: ScheduleInput,
  frequency: PeriodicFrequency,
): ScheduledInstalment[] {
  const r = periodicRate(input.annualRateBps, frequency);
  const n = input.term;
  const payment = roundMinor(annuityPayment(toDecimal(input.principal), r, n));
  let balance = input.principal;
  const rows: ScheduledInstalment[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const interest = roundMinor(toDecimal(balance).mul(r));
    let principal = seq === n ? balance : payment - interest;
    if (principal > balance) principal = balance;
    if (principal < 0n) principal = 0n;
    balance -= principal;
    rows.push(
      instalment(seq, dueDateFor(input.disbursementDate, frequency, seq), principal, interest),
    );
  }
  return rows;
}

/**
 * EQUAL_PRINCIPAL: principal ⌊P / n⌋ each period (remainder on the last), interest on the
 * outstanding balance rounded half-even.
 */
function equalPrincipal(input: ScheduleInput, frequency: PeriodicFrequency): ScheduledInstalment[] {
  const r = periodicRate(input.annualRateBps, frequency);
  const n = input.term;
  const base = input.principal / BigInt(n);
  let balance = input.principal;
  const rows: ScheduledInstalment[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const interest = roundMinor(toDecimal(balance).mul(r));
    const principal = seq === n ? balance : base;
    balance -= principal;
    rows.push(
      instalment(seq, dueDateFor(input.disbursementDate, frequency, seq), principal, interest),
    );
  }
  return rows;
}

/**
 * FLAT: total interest `I = P × rate × n / periodsPerYear` (rounded half-even) on the ORIGINAL
 * principal; both principal and interest are split ⌊x / n⌋ per instalment with the remainder
 * on the last, which keeps every component non-negative.
 */
function flat(input: ScheduleInput, frequency: PeriodicFrequency): ScheduledInstalment[] {
  const n = input.term;
  const totalInterest = roundMinor(
    toDecimal(input.principal)
      .mul(annualRate(input.annualRateBps))
      .mul(n)
      .div(PERIODS_PER_YEAR[frequency]),
  );
  const basePrincipal = input.principal / BigInt(n);
  const baseInterest = totalInterest / BigInt(n);
  const rest = BigInt(n - 1);
  const rows: ScheduledInstalment[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const last = seq === n;
    rows.push(
      instalment(
        seq,
        dueDateFor(input.disbursementDate, frequency, seq),
        last ? input.principal - basePrincipal * rest : basePrincipal,
        last ? totalInterest - baseInterest * rest : baseInterest,
      ),
    );
  }
  return rows;
}

function buildInstalments(input: ScheduleInput): ScheduledInstalment[] {
  const { frequency } = input;
  if (frequency === 'BULLET') return bulletSchedule(input);
  switch (input.method) {
    case 'REDUCING_BALANCE':
      return reducingBalance(input, frequency);
    case 'EQUAL_PRINCIPAL':
      return equalPrincipal(input, frequency);
    case 'FLAT':
      return flat(input, frequency);
  }
}

/**
 * Generate the contractual repayment schedule (SPEC §7.3).
 *
 * - Periods per year: DAILY 365, WEEKLY 52, BIWEEKLY 26, MONTHLY 12; r = annualRate / ppy.
 * - Due dates: disbursement + k periods (DAILY +1 d, WEEKLY +7 d, BIWEEKLY +14 d, MONTHLY
 *   +k calendar months clamped to month end relative to the original anchor day).
 * - BULLET: `term` is the tenor in days; one instalment, simple interest ACT/365F.
 * - Each component is rounded ROUND_HALF_EVEN to whole minor units; the last instalment
 *   absorbs residuals so Σprincipal == principal exactly and the balance ends at zero.
 */
export function generateSchedule(input: ScheduleInput): Schedule {
  validate(input);
  const instalments = buildInstalments(input);
  let totalPrincipal = 0n;
  let totalInterest = 0n;
  for (const row of instalments) {
    totalPrincipal += row.principal;
    totalInterest += row.interest;
  }
  const last = instalments[instalments.length - 1];
  if (!last) throw new ValidationError('Schedule has no instalments');
  return {
    currency: input.currency,
    instalments,
    totalPrincipal,
    totalInterest,
    totalRepayable: totalPrincipal + totalInterest,
    maturityDate: last.dueDate,
  };
}
