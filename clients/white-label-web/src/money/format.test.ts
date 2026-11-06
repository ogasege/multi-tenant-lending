import { describe, expect, it } from 'vitest';

import {
  currencyExponent,
  formatBps,
  formatMoney,
  isoDaysAgo,
  majorToMinor,
  minorToDecimalString,
  parseMoneyInput,
} from './format';

/** ICU uses narrow/no-break spaces in fr-SN; compare with plain spaces. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('currency exponents', () => {
  it('knows NGN has 2 decimals and XOF none', () => {
    expect(currencyExponent('NGN')).toBe(2);
    expect(currencyExponent('XOF')).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats NGN minor units for en-NG', () => {
    expect(formatMoney('125000000', 'NGN', 'en-NG')).toBe('₦1,250,000.00');
    expect(formatMoney('5', 'NGN', 'en-NG')).toBe('₦0.05');
    expect(formatMoney('0', 'NGN', 'en-NG')).toBe('₦0.00');
  });

  it('formats XOF (exponent 0) for fr-SN without decimals', () => {
    expect(plain(formatMoney('1250000', 'XOF', 'fr-SN'))).toBe('1 250 000 F CFA');
  });

  it('keeps precision beyond 2^53', () => {
    expect(formatMoney('900719925474099312', 'NGN', 'en-NG')).toBe('₦9,007,199,254,740,993.12');
  });

  it('formats negative balances', () => {
    expect(formatMoney('-98000000', 'NGN', 'en-NG')).toBe('-₦980,000.00');
  });

  it('rejects non-integer input', () => {
    expect(() => formatMoney('12.5', 'NGN', 'en-NG')).toThrow(RangeError);
  });
});

describe('minor/major conversions', () => {
  it('builds exact decimal strings', () => {
    expect(minorToDecimalString('7', 'NGN')).toBe('0.07');
    expect(minorToDecimalString('1250000', 'XOF')).toBe('1250000');
  });

  it('converts whole units to minor units', () => {
    expect(majorToMinor(1_250_000, 'NGN')).toBe('125000000');
    expect(majorToMinor(1_250_000, 'XOF')).toBe('1250000');
  });
});

describe('parseMoneyInput', () => {
  it('parses en-NG input with grouping', () => {
    expect(parseMoneyInput('1,250,000.50', 'NGN', 'en-NG')).toBe('125000050');
    expect(parseMoneyInput('₦ 400', 'NGN', 'en-NG')).toBe('40000');
  });

  it('parses fr-SN input with spaces and comma decimals', () => {
    expect(parseMoneyInput('1 250 000', 'XOF', 'fr-SN')).toBe('1250000');
    expect(parseMoneyInput('1 250 000', 'XOF', 'fr-SN')).toBe('1250000');
  });

  it('refuses more decimals than the currency has, and garbage', () => {
    expect(parseMoneyInput('10.5', 'XOF', 'fr-SN')).toBeNull();
    expect(parseMoneyInput('1.234', 'NGN', 'en-NG')).toBeNull();
    expect(parseMoneyInput('abc', 'NGN', 'en-NG')).toBeNull();
  });
});

describe('rates', () => {
  it('formats basis points as a localised percentage', () => {
    expect(formatBps(3625, 'en-NG')).toBe('36.3%');
    expect(plain(formatBps(2280, 'fr-SN'))).toBe('22,8 %');
  });
});

describe('isoDaysAgo', () => {
  it('counts calendar days back across month ends', () => {
    expect(isoDaysAgo(0, new Date(2026, 10, 7, 9))).toBe('2026-11-07');
    expect(isoDaysAgo(3, new Date(2026, 2, 2, 9))).toBe('2026-02-27');
  });
});
