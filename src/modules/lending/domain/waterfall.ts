import { ValidationError } from '../../../common/errors/app-error';

import {
  type ComponentAmounts,
  type InstalmentBalance,
  oldestFirst,
  outstandingOf,
} from './instalment-balance';

/** Allocation order within one instalment (SPEC §7.5). */
export const ALLOCATION_ORDER = ['penalty', 'fee', 'interest', 'principal'] as const;

export interface InstalmentAllocation extends ComponentAmounts {
  seq: number;
  total: bigint;
}

export interface AllocationResult {
  /** One entry per instalment that received money, oldest first. */
  allocations: InstalmentAllocation[];
  totals: ComponentAmounts & { total: bigint };
  /** Money left after every component of every instalment is settled (overpayment). */
  unallocated: bigint;
}

/**
 * Repayment waterfall (SPEC §7.5): money goes to the OLDEST instalment first (due date,
 * then seq) and, within each instalment, penalties → fees → interest → principal. Each
 * component receives at most its outstanding amount.
 *
 * Invariants: Σallocations + unallocated = amount; no component is over-paid; a later
 * component/instalment receives money only once every earlier one is fully settled.
 * Whether an unallocated remainder is acceptable (REPAYMENT_EXCEEDS_PAYOFF) is the caller's
 * decision.
 */
export function allocateRepayment(
  amount: bigint,
  instalments: readonly InstalmentBalance[],
): AllocationResult {
  if (amount < 0n) {
    throw new ValidationError('Repayment amount must be non-negative', [
      { field: 'amount', message: 'must be >= 0' },
    ]);
  }
  let remaining = amount;
  const totals = { penalty: 0n, fee: 0n, interest: 0n, principal: 0n, total: 0n };
  const allocations: InstalmentAllocation[] = [];

  for (const row of oldestFirst(instalments)) {
    const owed = outstandingOf(row);
    if (remaining === 0n) continue; // still validate every row
    const alloc: InstalmentAllocation = {
      seq: row.seq,
      penalty: 0n,
      fee: 0n,
      interest: 0n,
      principal: 0n,
      total: 0n,
    };
    for (const component of ALLOCATION_ORDER) {
      const take = owed[component] < remaining ? owed[component] : remaining;
      alloc[component] = take;
      alloc.total += take;
      totals[component] += take;
      remaining -= take;
    }
    if (alloc.total > 0n) allocations.push(alloc);
  }
  totals.total = amount - remaining;
  return { allocations, totals, unallocated: remaining };
}
