import fc from 'fast-check';

import { addDays } from './dates';
import { type InstalmentBalance, outstandingOf } from './instalment-balance';
import { earningHorizon, payoffQuote, settlementWaivers } from './payoff';
import { generateSchedule } from './schedule';
import { allocateRepayment } from './waterfall';

function balancesFor(principal: bigint, term: number): InstalmentBalance[] {
  return generateSchedule({
    principal,
    currency: 'NGN',
    annualRateBps: 2400,
    term,
    frequency: 'MONTHLY',
    method: 'REDUCING_BALANCE',
    disbursementDate: '2026-01-31',
  }).instalments.map((r) => ({
    seq: r.seq,
    dueDate: r.dueDate,
    principalDue: r.principal,
    principalPaid: 0n,
    interestDue: r.interest,
    interestPaid: 0n,
    feeDue: 0n,
    feePaid: 0n,
    penaltyDue: 0n,
    penaltyPaid: 0n,
  }));
}

function applyPaid(rows: InstalmentBalance[], amount: bigint): InstalmentBalance[] {
  const { allocations } = allocateRepayment(amount, rows);
  return rows.map((r) => {
    const a = allocations.find((x) => x.seq === r.seq);
    return a
      ? {
          ...r,
          penaltyPaid: r.penaltyPaid + a.penalty,
          feePaid: r.feePaid + a.fee,
          interestPaid: r.interestPaid + a.interest,
          principalPaid: r.principalPaid + a.principal,
        }
      : r;
  });
}

describe('payoff', () => {
  // ₦100,000 / 24 % / 12 months; #1 (28 Feb) paid in full, #2 (31 Mar) due and unpaid,
  // with a ₦472.80 late fee on #2. Quote as of 2026-04-15.
  const rows = applyPaid(balancesFor(10_000_000n, 12), 945_596n).map((r) =>
    r.seq === 2 ? { ...r, penaltyDue: 47_280n } : r,
  );

  it('charges due interest, waives future interest', () => {
    const q = payoffQuote(rows, '2026-04-15');
    // principal outstanding = 10,000,000 − 745,596 = 9,254,404
    expect(q.principal).toBe(9_254_404n);
    // only #2 interest is due on/before 15 Apr: 185,088
    expect(q.interest).toBe(185_088n);
    expect(q.penalties).toBe(47_280n);
    expect(q.fees).toBe(0n);
    expect(q.total).toBe(9_254_404n + 185_088n + 47_280n); // 9,486,772
    // waived: total interest 1,347,153 − 200,000 (#1) − 185,088 (#2) = 962,065
    expect(q.waivedInterest).toBe(962_065n);
  });

  it('an instalment due ON the as-of date is included', () => {
    expect(payoffQuote(rows, '2026-04-30').interest).toBe(185_088n + 169_878n);
  });

  it('settlement waivers cover every not-yet-due instalment', () => {
    const waivers = settlementWaivers(rows, '2026-04-15');
    expect(waivers.map((w) => w.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(waivers[0]).toEqual({ seq: 3, interestWaived: 169_878n });
    expect(waivers.reduce((a, w) => a + w.interestWaived, 0n)).toBe(962_065n);
  });

  describe('backdated settlement (value date before business today)', () => {
    // Value date 15 Apr, but business today is 30 Apr: #3 (due 30 Apr) is already earned.
    const options = { earnedThrough: '2026-04-30' };

    it('charges interest due up to business today, not just up to the value date', () => {
      const q = payoffQuote(rows, '2026-04-15', options);
      expect(q.asOf).toBe('2026-04-15');
      expect(q.interest).toBe(185_088n + 169_878n);
      expect(q).toEqual({ ...payoffQuote(rows, '2026-04-30'), asOf: '2026-04-15' });
    });

    it('never waives interest of an instalment due on or before business today', () => {
      const waivers = settlementWaivers(rows, '2026-04-15', options);
      expect(waivers.map((w) => w.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(waivers.reduce((a, w) => a + w.interestWaived, 0n)).toBe(
        payoffQuote(rows, '2026-04-15', options).waivedInterest,
      );
    });

    it('a value date after the horizon still decides (forward-dated quotes)', () => {
      expect(earningHorizon('2026-05-31', options)).toBe('2026-05-31');
      expect(earningHorizon('2026-04-15', options)).toBe('2026-04-30');
      expect(earningHorizon('2026-04-15')).toBe('2026-04-15');
    });
  });

  it('property: waivers + paying exactly the payoff settles everything with nothing left', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10_000n, max: 10n ** 11n }),
        fc.integer({ min: 1, max: 36 }),
        fc.integer({ min: -10, max: 1200 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 60 }),
        (principal, term, offsetDays, paidPct, backdatedDays) => {
          const fresh = balancesFor(principal, term);
          const totalDue = fresh.reduce((a, r) => a + r.principalDue + r.interestDue, 0n);
          const paid = applyPaid(fresh, (totalDue * BigInt(paidPct)) / 200n);
          const asOf = addDays('2026-01-31', offsetDays);
          const options = { earnedThrough: addDays(asOf, backdatedDays) };
          const quote = payoffQuote(paid, asOf, options);
          const waivers = settlementWaivers(paid, asOf, options);
          const horizon = earningHorizon(asOf, options);
          for (const w of waivers) {
            expect(paid.find((r) => r.seq === w.seq)?.dueDate.localeCompare(horizon)).toBe(1);
          }
          expect(waivers.reduce((a, w) => a + w.interestWaived, 0n)).toBe(quote.waivedInterest);
          const waived = paid.map((r) => ({
            ...r,
            interestWaived:
              (r.interestWaived ?? 0n) +
              (waivers.find((w) => w.seq === r.seq)?.interestWaived ?? 0n),
          }));
          const result = allocateRepayment(quote.total, waived);
          expect(result.unallocated).toBe(0n);
          const settled = applyPaid(waived, quote.total);
          for (const r of settled) {
            expect(outstandingOf(r)).toEqual({ penalty: 0n, fee: 0n, interest: 0n, principal: 0n });
          }
        },
      ),
    );
  });
});
