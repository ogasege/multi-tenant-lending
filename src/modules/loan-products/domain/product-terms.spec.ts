import { AppError } from '../../../common/errors/app-error';

import { type ProductTermsInput, validateProductTerms } from './product-terms';

const base: ProductTermsInput = {
  currency: 'NGN',
  minPrincipal: 1_000_000n,
  maxPrincipal: 100_000_000n,
  minTerm: 3,
  maxTerm: 12,
  repaymentFrequency: 'MONTHLY',
  interestMethod: 'REDUCING_BALANCE',
  annualInterestRateBps: 2400,
  originationFee: { type: 'PERCENTAGE', value: 200n, treatment: 'DEDUCTED' },
  lateFee: { type: 'FLAT', value: 50_000n, graceDays: 3 },
  maxDtiBps: 4000,
  minCreditScore: 0,
  applicationExpiryDays: 14,
  disbursementMode: 'VENDOR',
};
const ngn = { supportedCurrencies: ['NGN'], maxAprBps: null };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  return undefined;
}

describe('validateProductTerms', () => {
  it('accepts consistent terms and fixes the day count', () => {
    expect(validateProductTerms(base, ngn)).toMatchObject({
      currency: 'NGN',
      dayCount: 'ACT_365F',
    });
  });

  it.each<[string, Partial<ProductTermsInput>]>([
    ['inverted principal range', { minPrincipal: 10n, maxPrincipal: 5n }],
    ['inverted term range', { minTerm: 12, maxTerm: 3 }],
    ['BULLET tenor below 7 days', { repaymentFrequency: 'BULLET', minTerm: 5, maxTerm: 30 }],
    ['BULLET tenor above 365 days', { repaymentFrequency: 'BULLET', minTerm: 7, maxTerm: 400 }],
    ['monthly term above 30 years', { maxTerm: 361 }],
    [
      'NONE fee with a value',
      { originationFee: { type: 'NONE', value: 1n, treatment: 'DEDUCTED' } },
    ],
    [
      'percentage fee above 100 %',
      { lateFee: { type: 'PERCENTAGE', value: 10_001n, graceDays: 0 } },
    ],
    [
      'flat origination fee that eats the minimum principal',
      { originationFee: { type: 'FLAT', value: 1_000_000n, treatment: 'DEDUCTED' } },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(codeOf(() => validateProductTerms({ ...base, ...patch }, ngn))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('accepts BULLET tenors of 7–365 days', () => {
    const bullet = { ...base, repaymentFrequency: 'BULLET' as const, minTerm: 7, maxTerm: 365 };
    expect(() => validateProductTerms(bullet, ngn)).not.toThrow();
  });

  it('rejects a currency the institution does not offer', () => {
    expect(codeOf(() => validateProductTerms({ ...base, currency: 'XOF' }, ngn))).toBe(
      'UNSUPPORTED_CURRENCY',
    );
    expect(
      codeOf(() =>
        validateProductTerms(
          { ...base, currency: 'BTC' },
          { ...ngn, supportedCurrencies: ['BTC'] },
        ),
      ),
    ).toBe('UNSUPPORTED_CURRENCY');
  });

  it('rejects a nominal rate above the institution APR cap', () => {
    const capped = { supportedCurrencies: ['NGN'], maxAprBps: 2400 };
    expect(() => validateProductTerms(base, capped)).not.toThrow();
    expect(
      codeOf(() => validateProductTerms({ ...base, annualInterestRateBps: 2401 }, capped)),
    ).toBe('APR_EXCEEDS_CAP');
  });
});
