import fc from 'fast-check';

import type { InterestMethod, RepaymentFrequency } from '../../../common/database/schema';
import { ValidationError } from '../../../common/errors/app-error';

import { FinDecimal } from '../../../common/money/money';

import {
  annuityPayment,
  annuityPresentValue,
  generateSchedule,
  type ScheduleInput,
} from './schedule';

const base: ScheduleInput = {
  principal: 10_000_000n, // ₦100,000.00 in kobo
  currency: 'NGN',
  annualRateBps: 2400, // 24 % p.a. ⇒ r = 0.02 per month
  term: 12,
  frequency: 'MONTHLY',
  method: 'REDUCING_BALANCE',
  disbursementDate: '2026-01-31',
};

describe('generateSchedule', () => {
  describe('REDUCING_BALANCE, ₦100,000 at 24 % monthly × 12', () => {
    // A = P·r / (1 − (1+r)^−n) = 10,000,000 × 0.02 / (1 − 1.02^−12)
    //   1.02^12 = 1.26824179 ⇒ 1.02^−12 = 0.78849318 ⇒ 1 − … = 0.21150682
    //   A = 200,000 / 0.21150682 = 945,595.96 ⇒ 945,596 kobo (₦9,455.96)
    const s = generateSchedule(base);

    it('has a level instalment of ₦9,455.96', () => {
      for (const row of s.instalments.slice(0, 11)) expect(row.total).toBe(945_596n);
    });

    it('charges interest on the outstanding balance', () => {
      // #1: 10,000,000 × 0.02 = 200,000 interest; principal 945,596 − 200,000 = 745,596
      expect(s.instalments[0]).toMatchObject({ principal: 745_596n, interest: 200_000n });
      // #2: balance 9,254,404 × 0.02 = 185,088.08 ⇒ 185,088; principal 760,508
      expect(s.instalments[1]).toMatchObject({ principal: 760_508n, interest: 185_088n });
      // #12: remaining balance 927,056 × 0.02 = 18,541.12 ⇒ 18,541; total 945,597 (+1 residual)
      expect(s.instalments[11]).toMatchObject({ principal: 927_056n, interest: 18_541n });
    });

    it('totals and maturity', () => {
      expect(s.totalPrincipal).toBe(10_000_000n);
      expect(s.totalInterest).toBe(1_347_153n); // 11 × 945,596 + 945,597 − 10,000,000
      expect(s.totalRepayable).toBe(11_347_153n);
      expect(s.maturityDate).toBe('2027-01-31');
    });

    it('clamps due dates to month end relative to the 31st anchor (no drift)', () => {
      expect(s.instalments.map((r) => r.dueDate)).toEqual([
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
        '2026-05-31',
        '2026-06-30',
        '2026-07-31',
        '2026-08-31',
        '2026-09-30',
        '2026-10-31',
        '2026-11-30',
        '2026-12-31',
        '2027-01-31',
      ]);
    });
  });

  it('FLAT: interest on original principal spread evenly', () => {
    // I = 10,000,000 × 0.24 × 12/12 = 2,400,000 ⇒ 200,000 per month exactly
    // principal ⌊10,000,000 / 12⌋ = 833,333; last = 10,000,000 − 11 × 833,333 = 833,337
    const s = generateSchedule({ ...base, method: 'FLAT' });
    expect(s.totalInterest).toBe(2_400_000n);
    expect(s.instalments.every((r) => r.interest === 200_000n)).toBe(true);
    expect(s.instalments[0]?.principal).toBe(833_333n);
    expect(s.instalments[11]?.principal).toBe(833_337n);
  });

  it('FLAT: interest remainder lands on the last instalment', () => {
    // I = 1,000,000 × 0.10 × 3/12 = 25,000; ⌊25,000/3⌋ = 8,333; last = 25,000 − 16,666 = 8,334
    const s = generateSchedule({
      ...base,
      principal: 1_000_000n,
      annualRateBps: 1000,
      term: 3,
      method: 'FLAT',
    });
    expect(s.instalments.map((r) => r.interest)).toEqual([8_333n, 8_333n, 8_334n]);
  });

  it('EQUAL_PRINCIPAL: constant principal, declining interest', () => {
    // principal 833,333 × 11 + 833,337; interest #1 10,000,000 × 0.02 = 200,000;
    // #2 9,166,667 × 0.02 = 183,333.34 ⇒ 183,333; #3 8,333,334 × 0.02 = 166,666.68 ⇒ 166,667;
    // #12 833,337 × 0.02 = 16,666.74 ⇒ 16,667. Σinterest = 0.02 × Σbalances = 1,300,000
    const s = generateSchedule({ ...base, method: 'EQUAL_PRINCIPAL' });
    expect(s.instalments.slice(0, 3).map((r) => r.interest)).toEqual([
      200_000n,
      183_333n,
      166_667n,
    ]);
    expect(s.instalments[11]).toMatchObject({ principal: 833_337n, interest: 16_667n });
    expect(s.totalInterest).toBe(1_300_000n);
  });

  it('XOF (exponent 0): 1,000,000 FCFA at 18 % monthly × 6', () => {
    // r = 0.18/12 = 0.015; 1.015^6 = 1.09344326 ⇒ 1.015^−6 = 0.91454219
    // A = 15,000 / 0.08545781 = 175,525.25 ⇒ 175,525 FCFA (whole francs, no minor unit)
    // #1 interest 1,000,000 × 0.015 = 15,000; #2 839,475 × 0.015 = 12,592.125 ⇒ 12,592
    const s = generateSchedule({
      ...base,
      principal: 1_000_000n,
      currency: 'XOF',
      annualRateBps: 1800,
      term: 6,
      disbursementDate: '2026-03-15',
    });
    expect(s.currency).toBe('XOF');
    expect(s.instalments.slice(0, 5).every((r) => r.total === 175_525n)).toBe(true);
    expect(s.instalments[1]?.interest).toBe(12_592n);
    expect(s.instalments[5]?.total).toBe(175_526n); // residual on the last
    expect(s.totalPrincipal).toBe(1_000_000n);
    expect(s.maturityDate).toBe('2026-09-15');
  });

  it('BULLET: 30-day ₦500,000 at 24 % (vendor-paid inventory finance)', () => {
    // I = 50,000,000 × 0.24 × 30 / 365 = 986,301.37 ⇒ 986,301 kobo (₦9,863.01)
    const s = generateSchedule({
      ...base,
      principal: 50_000_000n,
      term: 30,
      frequency: 'BULLET',
      disbursementDate: '2026-11-06',
    });
    expect(s.instalments).toEqual([
      {
        seq: 1,
        dueDate: '2026-12-06',
        principal: 50_000_000n,
        interest: 986_301n,
        total: 50_986_301n,
      },
    ]);
    expect(s.maturityDate).toBe('2026-12-06');
  });

  it('BULLET ignores the interest method', () => {
    const a = generateSchedule({ ...base, term: 45, frequency: 'BULLET', method: 'FLAT' });
    const b = generateSchedule({
      ...base,
      term: 45,
      frequency: 'BULLET',
      method: 'EQUAL_PRINCIPAL',
    });
    expect(a).toEqual(b);
  });

  it.each([
    ['DAILY', ['2026-11-07', '2026-11-08', '2026-11-09']],
    ['WEEKLY', ['2026-11-13', '2026-11-20', '2026-11-27']],
    ['BIWEEKLY', ['2026-11-20', '2026-12-04', '2026-12-18']],
  ] as const)('%s due dates', (frequency, dates) => {
    const s = generateSchedule({ ...base, frequency, term: 3, disbursementDate: '2026-11-06' });
    expect(s.instalments.map((r) => r.dueDate)).toEqual(dates);
  });

  it('WEEKLY reducing balance uses r = rate / 52', () => {
    // r = 0.26/52 = 0.005; #1 interest 10,000,000 × 0.005 = 50,000
    // A = 50,000 / (1 − 1.005^−4) = 50,000 / 0.01975248 = 2,531,328.1 ⇒ 2,531,328
    const s = generateSchedule({ ...base, annualRateBps: 2600, term: 4, frequency: 'WEEKLY' });
    expect(s.instalments[0]).toMatchObject({ interest: 50_000n, total: 2_531_328n });
  });

  it('zero rate: P / n with no interest', () => {
    const s = generateSchedule({ ...base, annualRateBps: 0, term: 3, principal: 100n });
    expect(s.instalments.map((r) => [r.principal, r.interest])).toEqual([
      [33n, 0n],
      [33n, 0n],
      [34n, 0n],
    ]);
  });

  it.each([
    { principal: 0n },
    { term: 0 },
    { term: 1.5 },
    { annualRateBps: -1 },
    { annualRateBps: 12.5 },
    { disbursementDate: '2026-02-30' },
  ])('rejects invalid input %o', (patch) => {
    expect(() => generateSchedule({ ...base, ...patch })).toThrow(ValidationError);
  });

  it.each([
    ['0.02', 12],
    ['0', 3],
  ])('annuityPresentValue inverts annuityPayment (r = %s, n = %i)', (rate, n) => {
    const principal = new FinDecimal(10_000_000);
    const r = new FinDecimal(rate);
    const pv = annuityPresentValue(annuityPayment(principal, r, n), r, n);
    expect(pv.minus(principal).abs().lt('1e-20')).toBe(true);
  });

  describe('properties', () => {
    const frequencyArb = fc.constantFrom<RepaymentFrequency>(
      'BULLET',
      'DAILY',
      'WEEKLY',
      'BIWEEKLY',
      'MONTHLY',
    );
    const methodArb = fc.constantFrom<InterestMethod>(
      'REDUCING_BALANCE',
      'FLAT',
      'EQUAL_PRINCIPAL',
    );
    const inputArb = fc.record({
      principal: fc.bigInt({ min: 1n, max: 10n ** 12n }),
      currency: fc.constantFrom('NGN' as const, 'XOF' as const),
      annualRateBps: fc.integer({ min: 0, max: 15_000 }),
      term: fc.integer({ min: 1, max: 120 }),
      frequency: frequencyArb,
      method: methodArb,
      disbursementDate: fc.constantFrom('2026-01-31', '2026-02-28', '2024-02-29', '2026-11-06'),
    });

    it('Σprincipal == P, components ≥ 0, balance amortises to exactly zero', () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const s = generateSchedule(input);
          let balance = input.principal;
          for (const row of s.instalments) {
            expect(row.principal >= 0n && row.interest >= 0n).toBe(true);
            expect(row.total).toBe(row.principal + row.interest);
            balance -= row.principal;
            expect(balance >= 0n).toBe(true);
          }
          expect(balance).toBe(0n);
          expect(s.totalPrincipal).toBe(input.principal);
          expect(s.totalRepayable).toBe(s.totalPrincipal + s.totalInterest);
        }),
      );
    });

    it('due dates strictly increase and the count matches the term', () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const s = generateSchedule(input);
          expect(s.instalments).toHaveLength(input.frequency === 'BULLET' ? 1 : input.term);
          s.instalments.forEach((row, i) => {
            expect(row.seq).toBe(i + 1);
            const prev = s.instalments[i - 1];
            if (prev) expect(row.dueDate > prev.dueDate).toBe(true);
          });
          expect(s.maturityDate).toBe(s.instalments.at(-1)?.dueDate);
        }),
      );
    });

    it('REDUCING_BALANCE instalments are level (all but the last) for realistic principals', () => {
      fc.assert(
        fc.property(
          inputArb.filter((i) => i.frequency !== 'BULLET' && i.principal >= 1_000_000n),
          (input) => {
            const s = generateSchedule({ ...input, method: 'REDUCING_BALANCE' });
            const first = s.instalments[0]!.total;
            for (const row of s.instalments.slice(0, -1)) expect(row.total).toBe(first);
          },
        ),
      );
    });

    it('flat interest ≥ reducing-balance interest ≥ 0 for the same terms', () => {
      fc.assert(
        fc.property(
          inputArb.filter((i) => i.frequency !== 'BULLET' && i.principal >= 10_000n),
          (input) => {
            const rb = generateSchedule({ ...input, method: 'REDUCING_BALANCE' });
            const fl = generateSchedule({ ...input, method: 'FLAT' });
            // Rounding of each RB period can add at most ½ unit per instalment.
            expect(fl.totalInterest + BigInt(input.term) >= rb.totalInterest).toBe(true);
          },
        ),
      );
    });
  });
});
