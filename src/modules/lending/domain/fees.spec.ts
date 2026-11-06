import fc from 'fast-check';

import { ValidationError } from '../../../common/errors/app-error';

import { computeOrigination, feeAmount, lateFeeAmount } from './fees';

describe('fees', () => {
  it('2 % DEDUCTED origination fee on ₦100,000', () => {
    // fee = 10,000,000 × 200 / 10,000 = 200,000 kobo (₦2,000)
    expect(
      computeOrigination(10_000_000n, { type: 'PERCENTAGE', value: 200n, treatment: 'DEDUCTED' }),
    ).toEqual({
      approvedPrincipal: 10_000_000n,
      fee: 200_000n,
      financedPrincipal: 10_000_000n,
      netDisbursed: 9_800_000n,
    });
  });

  it('FLAT CAPITALISED origination fee', () => {
    // ₦5,000 fee financed on top of ₦100,000: financed ₦105,000, vendor/borrower gets ₦100,000
    expect(
      computeOrigination(10_000_000n, { type: 'FLAT', value: 500_000n, treatment: 'CAPITALISED' }),
    ).toEqual({
      approvedPrincipal: 10_000_000n,
      fee: 500_000n,
      financedPrincipal: 10_500_000n,
      netDisbursed: 10_000_000n,
    });
  });

  it('NONE ⇒ no fee', () => {
    expect(
      computeOrigination(1_000n, { type: 'NONE', value: 999n, treatment: 'DEDUCTED' }).fee,
    ).toBe(0n);
  });

  it('PERCENTAGE rounds half-even', () => {
    // XOF 12,345 × 1.5 % = 185.175 ⇒ 185 FCFA; 50 × 1 % = 0.5 ⇒ 0 (even); 150 × 1 % = 1.5 ⇒ 2
    expect(feeAmount(12_345n, { type: 'PERCENTAGE', value: 150n })).toBe(185n);
    expect(feeAmount(50n, { type: 'PERCENTAGE', value: 100n })).toBe(0n);
    expect(feeAmount(150n, { type: 'PERCENTAGE', value: 100n })).toBe(2n);
  });

  it.each([
    [1_000n, { type: 'FLAT', value: 1_000n, treatment: 'DEDUCTED' }], // fee == approved
    [1_000n, { type: 'PERCENTAGE', value: 10_000n, treatment: 'CAPITALISED' }], // 100 %
    [0n, { type: 'NONE', value: 0n, treatment: 'DEDUCTED' }], // zero principal
    [1_000n, { type: 'FLAT', value: -1n, treatment: 'DEDUCTED' }], // negative value
  ] as const)('rejects %s with %o', (approved, spec) => {
    expect(() => computeOrigination(approved, spec)).toThrow(ValidationError);
  });

  it('late fee: FLAT or PERCENTAGE of the overdue instalment', () => {
    // 5 % of 945,596 = 47,279.8 ⇒ 47,280 kobo
    expect(lateFeeAmount(945_596n, { type: 'PERCENTAGE', value: 500n })).toBe(47_280n);
    expect(lateFeeAmount(945_596n, { type: 'FLAT', value: 100_000n })).toBe(100_000n);
    expect(lateFeeAmount(945_596n, { type: 'NONE', value: 0n })).toBe(0n);
    expect(() => lateFeeAmount(-1n, { type: 'FLAT', value: 1n })).toThrow(ValidationError);
  });

  it('property: treatments conserve money', () => {
    fc.assert(
      fc.property(
        // ≥ 5,000 units so even a 99.99 % fee rounds strictly below the principal
        fc.bigInt({ min: 5_000n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 9_999 }),
        fc.constantFrom('DEDUCTED' as const, 'CAPITALISED' as const),
        (approved, bps, treatment) => {
          const o = computeOrigination(approved, {
            type: 'PERCENTAGE',
            value: BigInt(bps),
            treatment,
          });
          expect(o.fee >= 0n && o.fee < approved).toBe(true);
          expect(o.financedPrincipal - o.netDisbursed).toBe(o.fee);
          expect(o.netDisbursed > 0n).toBe(true);
        },
      ),
    );
  });
});
