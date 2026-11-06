import fc from 'fast-check';

import { ValidationError } from '../../../../common/errors/app-error';

import {
  assessCredit,
  type CreditAssessmentInput,
  gradeFor,
  KNOCK_OUT_REASONS,
  maxAffordablePrincipal,
  REASON_CODES,
} from './scorecard';

/**
 * Baseline: ₦100,000 (10,000,000 kobo), 24 % monthly × 12 reducing balance ⇒ instalment
 * 945,596 kobo = monthly equivalent. Income ₦100,000/month, no other debt:
 * DTI = 945,596 / 10,000,000 = 945.6 bps ⇒ 946. Points: score 750 → 40, DTI ≤ 20 % → 25,
 * tenure 48 → 20, clean bureau → 15 = 100 ⇒ grade A ⇒ APPROVE.
 */
const base: CreditAssessmentInput = {
  applicationDate: '2026-11-06',
  principal: 10_000_000n,
  term: 12,
  kycStatus: 'VERIFIED',
  ownerDateOfBirth: '1985-05-20',
  tenureMonths: 48,
  monthlyIncome: 10_000_000n,
  existingMonthlyDebt: 0n,
  existingTenantMaxDpd: 0,
  bureau: { score: 750, delinquent: false },
  product: {
    currency: 'NGN',
    annualRateBps: 2400,
    frequency: 'MONTHLY',
    method: 'REDUCING_BALANCE',
    minPrincipal: 5_000_000n,
    maxDtiBps: 4000,
    minCreditScore: 500,
  },
};

function assess(patch: Partial<CreditAssessmentInput>) {
  return assessCredit({ ...base, ...patch });
}

describe('assessCredit (scorecard-v1)', () => {
  it('approves a strong applicant', () => {
    const r = assessCredit(base);
    expect(r).toMatchObject({
      modelVersion: 'scorecard-v1',
      decision: 'APPROVE',
      grade: 'A',
      points: 100,
      pointsBreakdown: { bureauScore: 40, dti: 25, tenure: 20, bureauDelinquency: 15 },
      reasonCodes: [],
      dtiBps: 946,
      instalmentAmount: 945_596n,
      monthlyInstalment: 945_596n,
      maxAffordablePrincipal: null,
      ownerAge: 41,
    });
  });

  it.each([
    [{ kycStatus: 'PENDING' as const }, 'R05_KYC_NOT_VERIFIED'],
    [{ ownerDateOfBirth: '2008-11-07' }, 'R06_AGE_OUT_OF_RANGE'], // 17 (18 tomorrow)
    [{ ownerDateOfBirth: '1960-11-06' }, 'R06_AGE_OUT_OF_RANGE'], // 66 today
    [{ existingTenantMaxDpd: 31 }, 'R07_EXISTING_DELINQUENCY'],
    [{ bureau: { score: 700, delinquent: true } }, 'R04_BUREAU_DELINQUENCY'],
    [{ bureau: { score: 499, delinquent: false } }, 'R08_BELOW_MIN_SCORE'],
  ])('knock-out %o ⇒ DECLINE with %s', (patch, code) => {
    const r = assess(patch);
    expect(r.decision).toBe('DECLINE');
    expect(r.reasonCodes).toContain(code);
  });

  it.each([
    ['2008-11-06', 18], // 18th birthday today: eligible
    ['1960-11-07', 65], // turns 66 tomorrow: eligible
  ])('age boundary: born %s is %i and eligible', (dob, age) => {
    const r = assess({ ownerDateOfBirth: dob });
    expect(r.ownerAge).toBe(age);
    expect(r.reasonCodes).not.toContain('R06_AGE_OUT_OF_RANGE');
  });

  it('existing loan exactly 30 DPD is not a knock-out', () => {
    expect(assess({ existingTenantMaxDpd: 30 }).decision).toBe('APPROVE');
  });

  it('REFER on grade D', () => {
    // score 520 → 10 (and R02, < 580); tenure 3 → 0 (R03); clean → 15;
    // DTI (2,600,000 + 945,596) / 10,000,000 = 3,545.6 bps ⇒ 3546 → 10. Total 35 ⇒ D.
    const r = assess({
      bureau: { score: 520, delinquent: false },
      tenureMonths: 3,
      existingMonthlyDebt: 2_600_000n,
    });
    expect(r).toMatchObject({ points: 35, grade: 'D', decision: 'REFER', dtiBps: 3546 });
    expect(r.reasonCodes).toEqual(['R02_LOW_BUREAU_SCORE', 'R03_SHORT_EMPLOYMENT_TENURE']);
  });

  it('DECLINE on grade E', () => {
    // score 480 → 0 (min score lowered to 300 so R08 does not fire); tenure 3 → 0;
    // clean → 15; DTI 3546 → 10. Total 25 ⇒ E.
    const r = assess({
      bureau: { score: 480, delinquent: false },
      tenureMonths: 3,
      existingMonthlyDebt: 2_600_000n,
      product: { ...base.product, minCreditScore: 300 },
    });
    expect(r).toMatchObject({ points: 25, grade: 'E', decision: 'DECLINE' });
  });

  describe('counter-offer', () => {
    // Request ₦500,000: A = 50,000,000 × 0.0945596 = 4,727,980; existing debt 1,000,000
    // DTI = 5,727,980 / 10,000,000 = 5,728 bps > 4,000 ⇒ R01.
    // Budget = 40 % × 10,000,000 − 1,000,000 = 3,000,000 / month.
    // Invert the annuity: P = 3,000,000 × (1 − 1.02^−12) / 0.02 = 3,000,000 × 10.5753412
    //   = 31,726,023.6 ⇒ round down 31,726,023 kobo (₦317,260.23).
    const request = {
      principal: 50_000_000n,
      existingMonthlyDebt: 1_000_000n,
      bureau: { score: 700, delinquent: false },
      tenureMonths: 24,
    };

    it('offers the max affordable principal (annuity inversion)', () => {
      const r = assess(request);
      expect(r).toMatchObject({
        decision: 'COUNTER_OFFER',
        dtiBps: 5728,
        maxAffordablePrincipal: 31_726_023n,
        reasonCodes: ['R01_DTI_ABOVE_THRESHOLD'],
        // 30 (score) + 0 (DTI) + 15 (tenure) + 15 (clean) = 60 ⇒ C
        points: 60,
        grade: 'C',
      });
      const atOffer = assess({ ...request, principal: r.maxAffordablePrincipal! });
      expect(atOffer.reasonCodes).not.toContain('R01_DTI_ABOVE_THRESHOLD');
      expect(atOffer.dtiBps).toBeLessThanOrEqual(4000);
    });

    it('declines when the affordable amount is below the product minimum', () => {
      const r = assess({ ...request, product: { ...base.product, minPrincipal: 40_000_000n } });
      expect(r.decision).toBe('DECLINE');
      expect(r.maxAffordablePrincipal).toBe(31_726_023n);
    });

    it('declines when existing debt already exhausts the budget', () => {
      const r = assess({ ...request, existingMonthlyDebt: 4_000_000n });
      expect(r).toMatchObject({ decision: 'DECLINE', maxAffordablePrincipal: 0n });
    });

    it('scales linearly for FLAT', () => {
      // FLAT 24 %, 12 m on 50,000,000: first instalment 4,166,666 principal + 1,000,000 interest
      //   = 5,166,666. Linear scaling: 50,000,000 × 3,000,000 / 5,166,666 = 29,032,261.9
      //   ⇒ 29,032,261. Check: ⌊29,032,261/12⌋ = 2,419,355; interest 29,032,261 × 0.24
      //   = 6,967,742.64 ⇒ 6,967,743, ⌊/12⌋ = 580,645; instalment 3,000,000 = budget ✓.
      const r = assess({ ...request, product: { ...base.product, method: 'FLAT' } });
      expect(r.decision).toBe('COUNTER_OFFER');
      const offer = r.maxAffordablePrincipal!;
      expect(offer).toBe(29_032_261n);
      const at = assess({
        ...request,
        principal: offer,
        product: { ...base.product, method: 'FLAT' },
      });
      expect(at.reasonCodes).not.toContain('R01_DTI_ABOVE_THRESHOLD');
      const above = assess({
        ...request,
        principal: offer + 100n,
        product: { ...base.product, method: 'FLAT' },
      });
      expect(above.reasonCodes).toContain('R01_DTI_ABOVE_THRESHOLD');
    });
  });

  describe('maxAffordablePrincipal', () => {
    const flat = {
      ...base,
      principal: 50_000_000n,
      existingMonthlyDebt: 1_000_000n,
      product: { ...base.product, method: 'FLAT' as const },
    };
    const breaches = (principal: bigint): boolean =>
      assessCredit({ ...flat, principal }).reasonCodes.includes('R01_DTI_ABOVE_THRESHOLD');

    it.each([
      ['an understated requested instalment', 1n],
      ['a zero requested instalment', 0n],
    ])('binary-searches the largest fitting principal given %s', (_label, requested) => {
      // Both estimates clamp to the full 50,000,000 request, which breaches DTI.
      const p = maxAffordablePrincipal(flat, requested);
      expect(p > 0n && p < flat.principal).toBe(true);
      expect(breaches(p)).toBe(false);
      expect(breaches(p + 1n)).toBe(true);
    });
  });

  describe('BULLET affordability', () => {
    const bullet = { ...base.product, frequency: 'BULLET' as const };

    it('30-day bullet: whole repayment counts as one month', () => {
      // 50,000,000 × 0.24 × 30/365 = 986,301 interest ⇒ 50,986,301 over max(1, 30/30) = 1 month
      const r = assess({
        principal: 50_000_000n,
        term: 30,
        product: bullet,
        monthlyIncome: 200_000_000n,
      });
      expect(r.instalmentAmount).toBe(50_986_301n);
      expect(r.monthlyInstalment).toBe(50_986_301n);
      expect(r.dtiBps).toBe(2549); // 50,986,301 / 200,000,000 = 2,549.3 bps
    });

    it('90-day bullet spreads over 3 months', () => {
      // interest 50,000,000 × 0.24 × 90/365 = 2,958,904.1 ⇒ 2,958,904; total 52,958,904 / 3
      //   = 17,652,968
      const r = assess({
        principal: 50_000_000n,
        term: 90,
        product: bullet,
        monthlyIncome: 200_000_000n,
      });
      expect(r.monthlyInstalment).toBe(17_652_968n);
    });

    it('14-day bullet still counts as at least one month', () => {
      // 50,000,000 × 0.24 × 14/365 = 460,274 ⇒ 50,460,274 / max(1, 0.467) = 50,460,274
      const r = assess({
        principal: 50_000_000n,
        term: 14,
        product: bullet,
        monthlyIncome: 200_000_000n,
      });
      expect(r.monthlyInstalment).toBe(50_460_274n);
    });
  });

  it('reason codes are unique and in canonical order', () => {
    const r = assess({
      kycStatus: 'REJECTED',
      bureau: { score: 420, delinquent: true },
      tenureMonths: 1,
      existingMonthlyDebt: 9_000_000n,
    });
    expect(r.reasonCodes).toEqual([
      'R01_DTI_ABOVE_THRESHOLD',
      'R02_LOW_BUREAU_SCORE',
      'R03_SHORT_EMPLOYMENT_TENURE',
      'R04_BUREAU_DELINQUENCY',
      'R05_KYC_NOT_VERIFIED',
      'R08_BELOW_MIN_SCORE',
    ]);
    expect(r.decision).toBe('DECLINE');
    expect(r.maxAffordablePrincipal).toBeNull(); // no counter-offer for a knocked-out applicant
  });

  it.each([
    { monthlyIncome: 0n },
    { existingMonthlyDebt: -1n },
    { tenureMonths: -1 },
    { existingTenantMaxDpd: -1 },
    { bureau: { score: 900, delinquent: false } },
  ])('rejects invalid input %o', (patch) => {
    expect(() => assess(patch)).toThrow(ValidationError);
  });

  it('grade bands', () => {
    expect([100, 80, 79, 65, 64, 50, 49, 35, 34, 0].map(gradeFor)).toEqual([
      'A',
      'A',
      'B',
      'B',
      'C',
      'C',
      'D',
      'D',
      'E',
      'E',
    ]);
  });

  describe('properties', () => {
    const inputArb = fc.record({
      principal: fc.bigInt({ min: 5_000_000n, max: 200_000_000n }),
      term: fc.integer({ min: 1, max: 24 }),
      kycStatus: fc.constantFrom('VERIFIED' as const, 'PENDING' as const),
      tenureMonths: fc.integer({ min: 0, max: 120 }),
      monthlyIncome: fc.bigInt({ min: 1_000_000n, max: 100_000_000n }),
      existingMonthlyDebt: fc.bigInt({ min: 0n, max: 20_000_000n }),
      existingTenantMaxDpd: fc.integer({ min: 0, max: 60 }),
      bureau: fc.record({ score: fc.integer({ min: 300, max: 850 }), delinquent: fc.boolean() }),
      method: fc.constantFrom(
        'REDUCING_BALANCE' as const,
        'FLAT' as const,
        'EQUAL_PRINCIPAL' as const,
      ),
    });

    it('decision is consistent with reasons, grade and counter-offer amount', () => {
      fc.assert(
        fc.property(inputArb, ({ method, ...patch }) => {
          const input = { ...base, ...patch, product: { ...base.product, method } };
          const r = assessCredit(input);
          expect(new Set(r.reasonCodes).size).toBe(r.reasonCodes.length);
          expect(r.reasonCodes).toEqual(REASON_CODES.filter((c) => r.reasonCodes.includes(c)));
          expect(r.grade).toBe(gradeFor(r.points));
          if (r.reasonCodes.some((c) => KNOCK_OUT_REASONS.has(c)) || r.grade === 'E') {
            expect(r.decision).toBe('DECLINE');
          }
          if (r.decision === 'APPROVE')
            expect(r.reasonCodes).not.toContain('R01_DTI_ABOVE_THRESHOLD');
          if (r.decision === 'COUNTER_OFFER') {
            const offer = r.maxAffordablePrincipal!;
            expect(offer >= input.product.minPrincipal && offer < input.principal).toBe(true);
            const again = assessCredit({ ...input, principal: offer });
            expect(again.reasonCodes).not.toContain('R01_DTI_ABOVE_THRESHOLD');
          }
        }),
        { numRuns: 80 },
      );
    });
  });
});
