import { type IsoDate, assertIsoDate } from './dates';
import { type InstalmentBalance, oldestFirst, outstandingOf } from './instalment-balance';

export interface PayoffQuote {
  asOf: IsoDate;
  principal: bigint;
  /** Unpaid interest of instalments due on or before `asOf`. */
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

/**
 * Early-settlement payoff as of `asOf` (SPEC §7.5):
 * payoff = all outstanding principal + unpaid interest of instalments due on/before `asOf`
 * + all outstanding fees and penalties. Interest of instalments due after `asOf` is
 * unearned and waived (no accrual within a period: a period's interest is earned on its
 * due date — the simple, borrower-friendly convention for short-tenor B2B credit).
 */
export function payoffQuote(instalments: readonly InstalmentBalance[], asOf: IsoDate): PayoffQuote {
  assertIsoDate(asOf);
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
    if (row.dueDate <= asOf) quote.interest += owed.interest;
    else quote.waivedInterest += owed.interest;
  }
  quote.total = quote.principal + quote.interest + quote.fees + quote.penalties;
  return quote;
}

/**
 * Per-instalment interest waiver to record when a loan is settled at `asOf`: every
 * instalment due after `asOf` has its remaining interest waived. Applying these waivers
 * and then allocating exactly `payoffQuote(...).total` through the waterfall settles every
 * component with nothing left over. Returned oldest first; zero waivers are omitted.
 */
export function settlementWaivers(
  instalments: readonly InstalmentBalance[],
  asOf: IsoDate,
): InstalmentWaiver[] {
  assertIsoDate(asOf);
  return oldestFirst(instalments)
    .filter((row) => row.dueDate > asOf)
    .map((row) => ({ seq: row.seq, interestWaived: outstandingOf(row).interest }))
    .filter((w) => w.interestWaived > 0n);
}
