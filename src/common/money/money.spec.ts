import fc from 'fast-check';

import { AppError } from '../errors/app-error';

import { assertCurrency, exponentOf } from './currency';
import { applyBps, FinDecimal, Money, sumMinor } from './money';

describe('Money', () => {
  it('keeps currencies apart', () => {
    const ngn = Money.of(100n, 'NGN');
    expect(() => ngn.add(Money.of(1n, 'XOF'))).toThrow(AppError);
  });

  it('serialises amounts as strings to protect clients from float parsing', () => {
    expect(JSON.stringify(Money.of(9_007_199_254_740_993n, 'NGN'))).toBe(
      '{"amount":"9007199254740993","currency":"NGN"}',
    );
  });

  it('rounds half to even (banker’s rounding)', () => {
    expect(Money.fromDecimalMinor(new FinDecimal('2.5'), 'NGN').minor).toBe(2n);
    expect(Money.fromDecimalMinor(new FinDecimal('3.5'), 'NGN').minor).toBe(4n);
    expect(Money.fromDecimalMinor(new FinDecimal('-2.5'), 'NGN').minor).toBe(-2n);
  });

  it('knows XOF has no minor unit and NGN has two', () => {
    expect(exponentOf(assertCurrency('XOF'))).toBe(0);
    expect(exponentOf(assertCurrency('NGN'))).toBe(2);
    expect(() => assertCurrency('BTC')).toThrow(AppError);
  });

  it('supports arithmetic and comparisons within one currency', () => {
    const a = Money.of(500n, 'NGN');
    const b = Money.of(200n, 'NGN');
    expect(a.add(b).minor).toBe(700n);
    expect(a.subtract(b).minor).toBe(300n);
    expect(a.min(b)).toBe(b);
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.compare(Money.of(500n, 'NGN'))).toBe(0);
    expect(Money.zero('XOF').isZero()).toBe(true);
    expect(a.isPositive()).toBe(true);
    expect(b.subtract(a).isNegative()).toBe(true);
    expect(a.toDecimal().toString()).toBe('500');
    expect(sumMinor([1n, 2n, 3n])).toBe(6n);
  });

  describe('applyBps', () => {
    it('computes a 2% fee on ₦100,000.00 as ₦2,000.00', () => {
      expect(applyBps(10_000_000n, 200)).toBe(200_000n);
    });

    it('never exceeds the base amount for bps ≤ 10 000', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 15n }),
          fc.integer({ min: 0, max: 10_000 }),
          (m, bps) => {
            const fee = applyBps(m, bps);
            return fee >= 0n && fee <= m;
          },
        ),
      );
    });
  });
});
