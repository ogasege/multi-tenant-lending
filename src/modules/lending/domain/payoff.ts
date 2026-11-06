import { type IsoDate, assertIsoDate } from './dates';
import { type InstalmentBalance, oldestFirst, outstandingOf } from './instalment-balance';

export interface PayoffQuote {
  asOf: IsoDate;
  principal: bigint;
  /** Unpaid interest of instalments due on or before the earning horizon (see below). */
  interest: bigint;
  fees: bigint;
  penalties: bigint;
  total: bigint;
  /** Interest of not-yet-due instalments that settlement waives. */
  waivedInterest: bigint;
}

export interface InstalmentWaiver {
  seq: number;
  /** Additional interest to mark as waived on this instalment at settlement. */
  interestWaived: bigint;
}

export interface PayoffOptions {
  /**
   * Business today. Interest of instalments due on or before it is EARNED (end of day has
   * recognised it, or will for today), whatever the value date: a backdated settlement can
   * never waive it. Defaults to `asOf`.
   */
  earnedThrough?: IsoDate;
}

/**
 * The date up to which instalment interest is owed in full: the later of the value date and
 * business today. Interest of instalments due after it is unearned and waivable.
 */
export function earningHorizon(asOf: IsoDate, { earnedThrough }: PayoffOptions = {}): IsoDate {
  assertIsoDate(asOf);
  if (earnedThrough === undefined) return asOf;
  assertIsoDate(earnedThrough);
  return earnedThrough > asOf ? earnedThrough : asOf;
}

/**
 * Early-settlement payoff as of `asOf` (SPEC §7.5):
 * payoff = all outstanding principal + unpaid interest of instalments due on/before the
 * earning horizon (the later of `asOf` and `earnedThrough`, i.e. business today) + all
 * outstanding fees and penalties. Interest of instalments due after the horizon is
 * unearned and waived (no accrual within a period: a period's interest is earned on its
 * due date — the simple, borrower-friendly convention for short-tenor B2B credit).
 */
export function payoffQuote(
  instalments: readonly InstalmentBalance[],
  asOf: IsoDate,
  options: PayoffOptions = {},
): PayoffQuote {
  const horizon = earningHorizon(asOf, options);
  const quote: PayoffQuote = {
    asOf,
    principal: 0n,
    interest: 0n,
    fees: 0n,
    penalties: 0n,
    total: 0n,
    waivedInterest: 0n,
  };
  for (const row of instalments) {
    const owed = outstandingOf(row);
    quote.principal += owed.principal;
    quote.fees += owed.fee;
    quote.penalties += owed.penalty;
    if (row.dueDate <= horizon) quote.interest += owed.interest;
    else quote.waivedInterest += owed.interest;
  }
  quote.total = quote.principal + quote.interest + quote.fees + quote.penalties;
  return quote;
}

/**
 * Per-instalment interest waiver to record when a loan is settled at `asOf`: every
 * instalment due after the earning horizon (see {@link payoffQuote}; never on or before
 * business today) has its remaining interest waived. Applying these waivers and then
 * allocating exactly `payoffQuote(...).total` (same options) through the waterfall settles
 * every component with nothing left over. Returned oldest first; zero waivers are omitted.
 */
export function settlementWaivers(
  instalments: readonly InstalmentBalance[],
  asOf: IsoDate,
  options: PayoffOptions = {},
): InstalmentWaiver[] {
  const horizon = earningHorizon(asOf, options);
  return oldestFirst(instalments)
    .filter((row) => row.dueDate > horizon)
    .map((row) => ({ seq: row.seq, interestWaived: outstandingOf(row).interest }))
    .filter((w) => w.interestWaived > 0n);
}
