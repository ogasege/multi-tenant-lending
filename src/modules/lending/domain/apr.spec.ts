import fc from 'fast-check';

import type { InterestMethod } from '../../../common/database/schema';
import { BusinessRuleError, ValidationError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { FinDecimal } from '../../../common/money/money';

import { assertWithinAprCap, computeAprBps, solvePeriodicRate, totalCostOfCredit } from './apr';
import { generateSchedule, type PeriodicFrequency, type ScheduleInput } from './schedule';

const monthly: ScheduleInput = {
  principal: 10_000_000n,
  currency: 'NGN',
  annualRateBps: 2400,
  term: 12,
  frequency: 'MONTHLY',
  method: 'REDUCING_BALANCE',
  disbursementDate: '2026-01-31',
};

function aprFor(input: ScheduleInput, netDisbursed: bigint): number {
  const s = generateSchedule(input);
  return computeAprBps({
    netDisbursed,
    disbursementDate: input.disbursementDate,
    frequency: input.frequency,
    instalments: s.instalments,
  });
}

describe('APR', () => {
  it('no fee, reducing balance ⇒ APR equals the nominal rate (24.00 %)', () => {
    expect(aprFor(monthly, 10_000_000n)).toBe(2400);
  });

  it('2 % deducted fee raises the APR to 27.97 %', () => {
    // Net received 9,800,000; 12 × 945,596 (+1 on the last).
    // Check i = 0.2797 / 12 = 0.0233083: ln(1.0233083) = 0.0230408, × 12 = 0.276490,
    // e^−0.276490 = 0.758441; annuity factor (1 − 0.758441) / 0.0233083 = 10.36363;
    // 945,596 × 10.36363 ≈ 9,799,805, and at 27.965 % the PV is ≈ 9,800,054, so the
    // root (PV = 9,800,000) lies in [27.965 %, 27.97 %] and rounds to 2797 bps.
    expect(aprFor(monthly, 9_800_000n)).toBe(2797);
  });

  it('flat 24 % add-on ⇒ APR ≈ 41.70 % (why flat rates mislead)', () => {
    // 12 × 1,033,333 (+4 on the last) vs 10,000,000: i = 0.417 / 12 = 0.03475 ⇒ annuity
    // factor (1 − 1.03475^−12) / 0.03475 = 9.67757; 1,033,333 × 9.67757 ≈ 10,000,150.
    expect(aprFor({ ...monthly, method: 'FLAT' }, 10_000_000n)).toBe(4170);
  });

  it('BULLET uses the tenor as the unit period (ACT/365F)', () => {
    const bullet: ScheduleInput = {
      ...monthly,
      principal: 50_000_000n,
      term: 30,
      frequency: 'BULLET',
      disbursementDate: '2026-11-06',
    };
    // no fee: (50,986,301 / 50,000,000 − 1) × 365/30 = 0.01972602 × 12.1667 = 0.240000
    expect(aprFor(bullet, 50_000_000n)).toBe(2400);
    // 2 % deducted: (50,986,301 / 49,000,000 − 1) × 365/30 = 0.0405368 × 12.1667 = 0.49320
    expect(aprFor(bullet, 49_000_000n)).toBe(4932);
  });

  it('solver residual is negligible', () => {
    const flows = [1, 2, 3].map((t) => ({ t, amount: new FinDecimal(400) }));
    const i = solvePeriodicRate(new FinDecimal(1000), flows);
    const pv = flows.reduce(
      (acc, f) => acc.plus(f.amount.div(i.plus(1).pow(f.t))),
      new FinDecimal(0),
    );
    expect(pv.minus(1000).abs().lt('1e-15')).toBe(true);
  });

  it('handles a negative IRR (repayments below the advance)', () => {
    const apr = computeAprBps({
      netDisbursed: 1_000n,
      disbursementDate: '2026-01-01',
      frequency: 'MONTHLY',
      instalments: [{ seq: 1, dueDate: '2026-02-01', total: 990n }],
    });
    expect(apr).toBe(-1200); // i = −1 % per month × 12
  });

  it.each([
    { netDisbursed: 0n, instalments: [{ seq: 1, dueDate: '2026-02-01', total: 1n }] },
    { netDisbursed: 1n, instalments: [] },
  ])('rejects invalid input', (patch) => {
    expect(() =>
      computeAprBps({ disbursementDate: '2026-01-01', frequency: 'MONTHLY', ...patch }),
    ).toThrow(ValidationError);
  });

  it.each([
    [
      'two BULLET instalments',
      'BULLET',
      [
        { seq: 1, dueDate: '2026-02-01', total: 2n },
        { seq: 2, dueDate: '2026-03-01', total: 2n },
      ],
    ],
    ['a BULLET due on disbursement', 'BULLET', [{ seq: 1, dueDate: '2026-01-01', total: 2n }]],
    ['a non-positive seq', 'MONTHLY', [{ seq: 0, dueDate: '2026-02-01', total: 2n }]],
    ['a fractional seq', 'MONTHLY', [{ seq: 1.5, dueDate: '2026-02-01', total: 2n }]],
  ] as const)('rejects %s', (_label, frequency, instalments) => {
    expect(() =>
      computeAprBps({ netDisbursed: 1n, disbursementDate: '2026-01-01', frequency, instalments }),
    ).toThrow(ValidationError);
  });

  it('widens the bracket for periodic rates above 100 %', () => {
    // 1,000 advanced, 10,000 repaid one period later ⇒ i = 9 exactly.
    const i = solvePeriodicRate(new FinDecimal(1000), [{ t: 1, amount: new FinDecimal(10_000) }]);
    expect(i.minus(9).abs().lt('1e-15')).toBe(true);
  });

  it('refuses to solve when the periodic rate would exceed 1e9', () => {
    expect(() =>
      solvePeriodicRate(new FinDecimal(1), [{ t: 1, amount: new FinDecimal('1e12') }]),
    ).toThrow(ValidationError);
  });

  it('total cost of credit = total repayable − net disbursed', () => {
    // 11,347,153 − 9,800,000 = 1,547,153 (interest 1,347,153 + fee 200,000)
    expect(totalCostOfCredit(11_347_153n, 9_800_000n)).toBe(1_547_153n);
  });

  describe('assertWithinAprCap', () => {
    it('passes at or below the cap and with no cap', () => {
      expect(() => {
        assertWithinAprCap(3000, 3000);
      }).not.toThrow();
      expect(() => {
        assertWithinAprCap(9999, null);
      }).not.toThrow();
    });
    it('throws APR_EXCEEDS_CAP above the cap', () => {
      expect(() => {
        assertWithinAprCap(3001, 3000);
      }).toThrow(expect.objectContaining({ code: ErrorCode.APR_EXCEEDS_CAP }) as Error);
      expect(() => {
        assertWithinAprCap(3001, 3000);
      }).toThrow(BusinessRuleError);
    });
  });

  describe('properties', () => {
    const termsArb = fc.record({
      // ≥ ₦100,000: below ~5,000 × periodsPerYear minor units the ½-unit rounding of each
      // interest component alone can move the APR by more than 1 bp (e.g. 2-day DAILY loans).
      principal: fc.bigInt({ min: 10_000_000n, max: 10n ** 11n }),
      annualRateBps: fc.integer({ min: 100, max: 6_000 }),
      term: fc.integer({ min: 2, max: 36 }),
      frequency: fc.constantFrom<PeriodicFrequency>('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'),
    });

    it('no fee, reducing balance ⇒ APR within ±1 bp of nominal', () => {
      fc.assert(
        fc.property(termsArb, (t) => {
          const apr = aprFor({ ...monthly, ...t }, t.principal);
          expect(Math.abs(apr - t.annualRateBps)).toBeLessThanOrEqual(1);
        }),
        { numRuns: 60 },
      );
    });

    it('a deducted fee > 0 ⇒ APR ≥ nominal and ≥ the no-fee APR', () => {
      fc.assert(
        fc.property(
          termsArb,
          fc.integer({ min: 10, max: 500 }),
          fc.constantFrom<InterestMethod>('REDUCING_BALANCE', 'FLAT', 'EQUAL_PRINCIPAL'),
          (t, feeBps, method) => {
            const input = { ...monthly, ...t, method };
            const fee = (t.principal * BigInt(feeBps)) / 10_000n;
            const withFee = aprFor(input, t.principal - fee);
            expect(withFee).toBeGreaterThanOrEqual(t.annualRateBps);
            expect(withFee).toBeGreaterThanOrEqual(aprFor(input, t.principal));
          },
        ),
        { numRuns: 60 },
      );
    });
  });
});
