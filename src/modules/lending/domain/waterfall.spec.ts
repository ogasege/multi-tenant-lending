import fc from 'fast-check';

import { ValidationError } from '../../../common/errors/app-error';

import { type InstalmentBalance, outstandingOf } from './instalment-balance';
import { ALLOCATION_ORDER, allocateRepayment } from './waterfall';

function row(
  seq: number,
  dueDate: string,
  patch: Partial<InstalmentBalance> = {},
): InstalmentBalance {
  return {
    seq,
    dueDate,
    principalDue: 745_596n,
    principalPaid: 0n,
    interestDue: 200_000n,
    interestPaid: 0n,
    feeDue: 0n,
    feePaid: 0n,
    penaltyDue: 0n,
    penaltyPaid: 0n,
    ...patch,
  };
}

describe('allocateRepayment', () => {
  const overdue1 = row(1, '2026-02-28', { penaltyDue: 47_280n, feeDue: 10_000n });
  const overdue2 = row(2, '2026-03-31', { principalDue: 760_508n, interestDue: 185_088n });

  it('settles the oldest instalment first: penalty → fee → interest → principal', () => {
    // 1,000,000 → #1 penalty 47,280, fee 10,000, interest 200,000, principal 742,720
    // (1,000,000 − 47,280 − 10,000 − 200,000 = 742,720 of 745,596); nothing reaches #2.
    const r = allocateRepayment(1_000_000n, [overdue2, overdue1]); // unordered input
    expect(r.allocations).toEqual([
      {
        seq: 1,
        penalty: 47_280n,
        fee: 10_000n,
        interest: 200_000n,
        principal: 742_720n,
        total: 1_000_000n,
      },
    ]);
    expect(r.unallocated).toBe(0n);
  });

  it('flows into the next instalment once the first is cleared', () => {
    // #1 owes 47,280 + 10,000 + 200,000 + 745,596 = 1,002,876; 1,200,000 − 1,002,876 = 197,124
    // → #2 interest 185,088, principal 12,036.
    const r = allocateRepayment(1_200_000n, [overdue1, overdue2]);
    expect(r.allocations[1]).toEqual({
      seq: 2,
      penalty: 0n,
      fee: 0n,
      interest: 185_088n,
      principal: 12_036n,
      total: 197_124n,
    });
    expect(r.totals).toEqual({
      penalty: 47_280n,
      fee: 10_000n,
      interest: 385_088n,
      principal: 757_632n,
      total: 1_200_000n,
    });
  });

  it('respects partial payments already made and waived interest', () => {
    const partial = row(1, '2026-02-28', {
      interestPaid: 150_000n,
      interestWaived: 20_000n,
      principalPaid: 700_000n,
    });
    // outstanding: interest 200,000 − 150,000 − 20,000 = 30,000; principal 45,596
    const r = allocateRepayment(100_000n, [partial]);
    expect(r.allocations[0]).toMatchObject({ interest: 30_000n, principal: 45_596n });
    expect(r.unallocated).toBe(100_000n - 75_596n);
  });

  it('returns an overpayment as unallocated', () => {
    const r = allocateRepayment(5_000_000n, [overdue1]);
    expect(r.totals.total).toBe(1_002_876n);
    expect(r.unallocated).toBe(3_997_124n);
  });

  it('zero amount allocates nothing; empty schedule leaves all unallocated', () => {
    expect(allocateRepayment(0n, [overdue1]).allocations).toEqual([]);
    expect(allocateRepayment(10n, []).unallocated).toBe(10n);
  });

  it('ties on due date are broken by seq', () => {
    const a = row(2, '2026-02-28');
    const b = row(1, '2026-02-28');
    expect(allocateRepayment(1n, [a, b]).allocations[0]?.seq).toBe(1);
  });

  it.each([
    [-1n, [overdue1]],
    [1n, [row(1, '2026-01-01', { principalPaid: 745_597n })]], // paid > due
    [1n, [row(1, '2026-01-01', { interestPaid: 190_000n, interestWaived: 20_000n })]],
  ])('rejects invalid input', (amount, rows) => {
    expect(() => allocateRepayment(amount, rows)).toThrow(ValidationError);
  });

  describe('properties', () => {
    const rowArb = fc
      .record({
        seq: fc.integer({ min: 1, max: 1000 }),
        day: fc.integer({ min: 0, max: 400 }),
        principalDue: fc.bigInt({ min: 0n, max: 10n ** 9n }),
        interestDue: fc.bigInt({ min: 0n, max: 10n ** 8n }),
        feeDue: fc.bigInt({ min: 0n, max: 10n ** 6n }),
        penaltyDue: fc.bigInt({ min: 0n, max: 10n ** 6n }),
        paidShare: fc.integer({ min: 0, max: 100 }),
      })
      .map((r): InstalmentBalance => ({
        seq: r.seq,
        dueDate: new Date(Date.UTC(2026, 0, 1 + r.day)).toISOString().slice(0, 10),
        principalDue: r.principalDue,
        principalPaid: (r.principalDue * BigInt(r.paidShare)) / 100n,
        interestDue: r.interestDue,
        interestPaid: (r.interestDue * BigInt(r.paidShare)) / 100n,
        feeDue: r.feeDue,
        feePaid: 0n,
        penaltyDue: r.penaltyDue,
        penaltyPaid: 0n,
      }));
    const caseArb = fc.record({
      rows: fc.uniqueArray(rowArb, { selector: (r) => r.seq, maxLength: 12 }),
      amount: fc.bigInt({ min: 0n, max: 5n * 10n ** 9n }),
    });

    it('conserves money and never over-pays a component', () => {
      fc.assert(
        fc.property(caseArb, ({ rows, amount }) => {
          const r = allocateRepayment(amount, rows);
          const allocated = r.allocations.reduce((acc, a) => acc + a.total, 0n);
          expect(allocated + r.unallocated).toBe(amount);
          expect(r.totals.total).toBe(allocated);
          expect(r.unallocated >= 0n).toBe(true);
          for (const a of r.allocations) {
            const owed = outstandingOf(rows.find((x) => x.seq === a.seq)!);
            for (const c of ALLOCATION_ORDER) {
              expect(a[c] >= 0n && a[c] <= owed[c]).toBe(true);
            }
            expect(a.total).toBe(a.penalty + a.fee + a.interest + a.principal);
          }
        }),
      );
    });

    it('respects order: nothing is paid after a component left short; surplus only when all settled', () => {
      fc.assert(
        fc.property(caseArb, ({ rows, amount }) => {
          const r = allocateRepayment(amount, rows);
          const ordered = [...rows].sort((a, b) =>
            a.dueDate === b.dueDate ? a.seq - b.seq : a.dueDate < b.dueDate ? -1 : 1,
          );
          let shortfallSeen = false;
          for (const inst of ordered) {
            const owed = outstandingOf(inst);
            const a = r.allocations.find((x) => x.seq === inst.seq);
            for (const c of ALLOCATION_ORDER) {
              const paid = a?.[c] ?? 0n;
              if (shortfallSeen) expect(paid).toBe(0n);
              if (paid < owed[c]) shortfallSeen = true;
            }
          }
          if (r.unallocated > 0n) expect(shortfallSeen).toBe(false);
        }),
      );
    });
  });
});
