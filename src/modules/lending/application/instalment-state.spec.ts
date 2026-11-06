import { allocateRepayment, settlementWaivers } from '../domain';

import {
  type InstalmentState,
  oldestUnpaidDueDate,
  outstandingSummary,
  outstandingTotal,
  paymentColumnsChanged,
  statusOf,
  toBalance,
  withAllocation,
  withWaivers,
} from './instalment-state';

const row = (
  seq: number,
  dueDate: string,
  patch: Partial<InstalmentState> = {},
): InstalmentState => ({
  id: `i${seq}`,
  seq,
  due_date: dueDate,
  principal_due: 10_000n,
  interest_due: 1_000n,
  fee_due: 0n,
  penalty_due: 0n,
  principal_paid: 0n,
  interest_paid: 0n,
  fee_paid: 0n,
  penalty_paid: 0n,
  interest_waived: 0n,
  interest_accrued: false,
  status: 'PENDING',
  ...patch,
});

describe('instalment state', () => {
  const rows = [
    row(1, '2026-02-15', { penalty_due: 500n }),
    row(2, '2026-03-15'),
    row(3, '2026-04-15'),
  ];

  it('maps rows to domain balances', () => {
    expect(toBalance(rows[0]!)).toMatchObject({
      seq: 1,
      dueDate: '2026-02-15',
      principalDue: 10_000n,
      penaltyDue: 500n,
      interestWaived: 0n,
    });
  });

  it('outstanding total and status', () => {
    expect(outstandingTotal(rows[0]!)).toBe(11_500n);
    expect(statusOf(rows[1]!)).toBe('PENDING');
    expect(statusOf(row(1, '2026-02-15', { interest_paid: 1n }))).toBe('PARTIALLY_PAID');
    expect(
      statusOf(
        row(1, '2026-02-15', {
          principal_paid: 10_000n,
          interest_paid: 400n,
          interest_waived: 600n,
        }),
      ),
    ).toBe('PAID');
  });

  it('applies a waterfall allocation to the paid columns', () => {
    // 12,000 = inst 1 (penalty 500 + interest 1,000 + principal 10,000 = 11,500) + 500 of
    // inst 2 interest.
    const allocation = allocateRepayment(12_000n, rows.map(toBalance));
    const after = withAllocation(rows, allocation);
    expect(after[0]).toMatchObject({
      penalty_paid: 500n,
      interest_paid: 1_000n,
      principal_paid: 10_000n,
      status: 'PAID',
    });
    expect(after[1]).toMatchObject({
      interest_paid: 500n,
      principal_paid: 0n,
      status: 'PARTIALLY_PAID',
    });
    expect(after[2]).toBe(rows[2]);
    expect(oldestUnpaidDueDate(after)).toBe('2026-03-15');
  });

  it('settlement: waivers + exact payoff leave nothing outstanding', () => {
    const asOf = '2026-02-20';
    const waivers = settlementWaivers(rows.map(toBalance), asOf);
    expect(waivers).toEqual([
      { seq: 2, interestWaived: 1_000n },
      { seq: 3, interestWaived: 1_000n },
    ]);
    const waived = withWaivers(rows, waivers);
    // payoff = 30,000 principal + 1,000 interest (inst 1) + 500 penalty
    const after = withAllocation(waived, allocateRepayment(31_500n, waived.map(toBalance)));
    expect(outstandingSummary(after).total).toBe(0n);
    expect(after.every((r) => r.status === 'PAID')).toBe(true);
    expect(oldestUnpaidDueDate(after)).toBeNull();
  });

  it('summarises outstanding components', () => {
    expect(outstandingSummary(rows)).toEqual({
      principal: 30_000n,
      interest: 3_000n,
      fees: 0n,
      penalties: 500n,
      total: 33_500n,
    });
  });
});

describe('paymentColumnsChanged', () => {
  it('detects a paid or waived column change, ignoring other columns', () => {
    const before = row(1, '2026-02-01');
    expect(paymentColumnsChanged(before, { ...before, status: 'PAID' })).toBe(false);
    expect(paymentColumnsChanged(before, { ...before, fee_paid: 1n })).toBe(true);
    expect(paymentColumnsChanged(before, { ...before, interest_waived: 1n })).toBe(true);
  });
});
