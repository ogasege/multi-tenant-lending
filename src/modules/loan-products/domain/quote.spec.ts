import type { AppError } from '../../../common/errors/app-error';

import type { ProductTerms } from './product-terms';
import { assertProductAprWithinCap, buildQuote, worstCaseAprBps } from './quote';

const monthlyNgn: ProductTerms = {
  currency: 'NGN',
  minPrincipal: 1_000_000n,
  maxPrincipal: 100_000_000n,
  minTerm: 3,
  maxTerm: 24,
  repaymentFrequency: 'MONTHLY',
  interestMethod: 'REDUCING_BALANCE',
  annualInterestRateBps: 2400,
  dayCount: 'ACT_365F',
  originationFee: { type: 'NONE', value: 0n, treatment: 'DEDUCTED' },
  lateFee: { type: 'NONE', value: 0n, graceDays: 0 },
  maxDtiBps: 4000,
  minCreditScore: 0,
  applicationExpiryDays: 14,
  disbursementMode: 'BORROWER',
};

const bulletXof: ProductTerms = {
  ...monthlyNgn,
  currency: 'XOF',
  minPrincipal: 100_000n,
  maxPrincipal: 10_000_000n,
  minTerm: 7,
  maxTerm: 90,
  repaymentFrequency: 'BULLET',
  annualInterestRateBps: 1800,
};

const request = { principal: 10_000_000n, term: 12, disbursementDate: '2026-01-15' };

describe('buildQuote', () => {
  it('quotes a ₦100,000 / 12-month / 24 % reducing-balance loan', () => {
    const q = buildQuote(monthlyNgn, request, null);
    // Annuity 100 000 × 0.02 / (1 − 1.02^−12) = ₦9 455.96.
    expect(q.instalments).toHaveLength(12);
    expect(q.instalments[0]).toMatchObject({ dueDate: '2026-02-15', total: 945_596n });
    expect(q.instalments.reduce((s, i) => s + i.principal, 0n)).toBe(10_000_000n);
    expect(q.totalRepayable).toBe(q.totalInterest + 10_000_000n);
    expect(q.totalInterest).toBeGreaterThan(1_340_000n);
    expect(q.totalInterest).toBeLessThan(1_355_000n);
    expect(q.netDisbursed).toBe(10_000_000n);
    expect(q.aprBps).toBe(2400);
    expect(q.totalCostOfCredit).toBe(q.totalInterest);
    expect(q.aprWithinCap).toBe(true);
  });

  it('puts a deducted fee into the APR and the cost of credit', () => {
    const withFee: ProductTerms = {
      ...monthlyNgn,
      originationFee: { type: 'PERCENTAGE', value: 200n, treatment: 'DEDUCTED' },
    };
    const q = buildQuote(withFee, request, 2600);
    expect(q.originationFee).toBe(200_000n);
    expect(q.netDisbursed).toBe(9_800_000n);
    expect(q.financedPrincipal).toBe(10_000_000n);
    expect(q.totalCostOfCredit).toBe(q.totalInterest + 200_000n);
    expect(q.aprBps).toBeGreaterThan(2700);
    expect(q.aprWithinCap).toBe(false);
  });

  it('capitalises a fee into the financed principal', () => {
    const capitalised: ProductTerms = {
      ...monthlyNgn,
      originationFee: { type: 'FLAT', value: 100_000n, treatment: 'CAPITALISED' },
    };
    const q = buildQuote(capitalised, request, null);
    expect(q.financedPrincipal).toBe(10_100_000n);
    expect(q.netDisbursed).toBe(10_000_000n);
    expect(q.aprBps).toBeGreaterThan(2400);
  });

  it('quotes an XOF 90-day bullet with simple ACT/365 interest and no minor unit', () => {
    const q = buildQuote(bulletXof, { ...request, principal: 1_000_000n, term: 90 }, 2400);
    // 1 000 000 × 18 % × 90 / 365 = 44 383.56 → 44 384 (XOF has no minor unit).
    expect(q.instalments).toEqual([
      {
        seq: 1,
        dueDate: '2026-04-15',
        principal: 1_000_000n,
        interest: 44_384n,
        total: 1_044_384n,
      },
    ]);
    expect(q).toMatchObject({ termUnit: 'DAYS', interestMethod: 'SIMPLE', aprBps: 1800 });
  });

  it.each([
    [{ principal: 999_999n }, 'AMOUNT_OUT_OF_PRODUCT_RANGE'],
    [{ principal: 100_000_001n }, 'AMOUNT_OUT_OF_PRODUCT_RANGE'],
    [{ term: 2 }, 'TERM_OUT_OF_PRODUCT_RANGE'],
    [{ term: 25 }, 'TERM_OUT_OF_PRODUCT_RANGE'],
  ])('rejects %o with %s', (patch, code) => {
    expect(() => buildQuote(monthlyNgn, { ...request, ...patch }, null)).toThrow(
      expect.objectContaining({ code }) as AppError,
    );
  });
});

describe('worst-case product APR (all-in, fees included)', () => {
  const withFee: ProductTerms = {
    ...monthlyNgn,
    originationFee: { type: 'FLAT', value: 100_000n, treatment: 'DEDUCTED' },
  };

  it('is driven by the minimum principal and term when a fee is charged', () => {
    const worst = worstCaseAprBps(withFee);
    const atMin = buildQuote(
      withFee,
      { principal: withFee.minPrincipal, term: withFee.minTerm, disbursementDate: '2026-01-15' },
      null,
    ).aprBps;
    expect(worst).toBe(atMin);
    expect(worst).toBeGreaterThan(withFee.annualInterestRateBps);
  });

  it('rejects terms whose nominal rate is under the cap but whose all-in APR is not', () => {
    // 24 % nominal is under a 30 % cap, but a ₦1,000 fee on ₦10,000 over 3 months is not.
    expect(() => {
      assertProductAprWithinCap(withFee, 3000);
    }).toThrow(expect.objectContaining({ status: 422, code: 'APR_EXCEEDS_CAP' }));
    expect(() => {
      assertProductAprWithinCap(monthlyNgn, 3000);
    }).not.toThrow();
    expect(() => {
      assertProductAprWithinCap(withFee, null);
    }).not.toThrow();
  });
});
