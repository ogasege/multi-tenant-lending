import type { InstalmentStatus } from '../../../common/database/schema';
import {
  type AllocationResult,
  type InstalmentBalance,
  type InstalmentWaiver,
  type IsoDate,
  outstandingOf,
} from '../domain';

/** The persisted columns of one instalment that this module reads and writes. */
export interface InstalmentState {
  id: string;
  seq: number;
  due_date: string;
  principal_due: bigint;
  interest_due: bigint;
  fee_due: bigint;
  penalty_due: bigint;
  principal_paid: bigint;
  interest_paid: bigint;
  fee_paid: bigint;
  penalty_paid: bigint;
  interest_waived: bigint;
  interest_accrued: boolean;
  status: InstalmentStatus;
}

/** Row → domain balance used by the waterfall, payoff and DPD functions. */
export function toBalance(row: InstalmentState): InstalmentBalance {
  return {
    seq: row.seq,
    dueDate: row.due_date,
    principalDue: row.principal_due,
    principalPaid: row.principal_paid,
    interestDue: row.interest_due,
    interestPaid: row.interest_paid,
    interestWaived: row.interest_waived,
    feeDue: row.fee_due,
    feePaid: row.fee_paid,
    penaltyDue: row.penalty_due,
    penaltyPaid: row.penalty_paid,
  };
}

/** Total still owed on one instalment (all components, after waivers). */
export function outstandingTotal(row: InstalmentState): bigint {
  const o = outstandingOf(toBalance(row));
  return o.principal + o.interest + o.fee + o.penalty;
}

/** PAID when nothing is owed, PARTIALLY_PAID once anything was paid, else PENDING. */
export function statusOf(row: InstalmentState): InstalmentStatus {
  if (outstandingTotal(row) === 0n) return 'PAID';
  const paid = row.principal_paid + row.interest_paid + row.fee_paid + row.penalty_paid;
  return paid > 0n ? 'PARTIALLY_PAID' : 'PENDING';
}

/** Due date of the oldest instalment that still has something outstanding (DPD anchor). */
export function oldestUnpaidDueDate(rows: readonly InstalmentState[]): IsoDate | null {
  let oldest: IsoDate | null = null;
  for (const row of rows) {
    if (outstandingTotal(row) > 0n && (oldest === null || row.due_date < oldest)) {
      oldest = row.due_date;
    }
  }
  return oldest;
}

/** Copy of `rows` with settlement waivers added to `interest_waived`. */
export function withWaivers<T extends InstalmentState>(
  rows: readonly T[],
  waivers: readonly InstalmentWaiver[],
): T[] {
  const bySeq = new Map(waivers.map((w) => [w.seq, w.interestWaived]));
  return rows.map((row) => {
    const extra = bySeq.get(row.seq) ?? 0n;
    return extra === 0n ? row : { ...row, interest_waived: row.interest_waived + extra };
  });
}

/**
 * Copy of `rows` with a waterfall allocation applied to the paid columns and the status
 * recomputed. Rows that received nothing are returned unchanged (same object).
 */
export function withAllocation<T extends InstalmentState>(
  rows: readonly T[],
  allocation: AllocationResult,
): T[] {
  const bySeq = new Map(allocation.allocations.map((a) => [a.seq, a]));
  return rows.map((row) => {
    const a = bySeq.get(row.seq);
    if (!a) return row;
    const next: T = {
      ...row,
      principal_paid: row.principal_paid + a.principal,
      interest_paid: row.interest_paid + a.interest,
      fee_paid: row.fee_paid + a.fee,
      penalty_paid: row.penalty_paid + a.penalty,
    };
    return { ...next, status: statusOf(next) };
  });
}

/** Whether a repayment changed any paid or waived column of an instalment. */
export function paymentColumnsChanged(before: InstalmentState, after: InstalmentState): boolean {
  return (
    after.principal_paid !== before.principal_paid ||
    after.interest_paid !== before.interest_paid ||
    after.fee_paid !== before.fee_paid ||
    after.penalty_paid !== before.penalty_paid ||
    after.interest_waived !== before.interest_waived
  );
}

/** Sum of outstanding amounts by component over all instalments. */
export function outstandingSummary(rows: readonly InstalmentState[]): {
  principal: bigint;
  interest: bigint;
  fees: bigint;
  penalties: bigint;
  total: bigint;
} {
  const sum = { principal: 0n, interest: 0n, fees: 0n, penalties: 0n, total: 0n };
  for (const row of rows) {
    const o = outstandingOf(toBalance(row));
    sum.principal += o.principal;
    sum.interest += o.interest;
    sum.fees += o.fee;
    sum.penalties += o.penalty;
  }
  sum.total = sum.principal + sum.interest + sum.fees + sum.penalties;
  return sum;
}
