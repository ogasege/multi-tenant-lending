import Decimal from 'decimal.js';

import { BusinessRuleError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

import type { CurrencyCode } from './currency';

/**
 * Decimal configuration for all financial maths: 34 significant digits (IEEE 754 decimal128)
 * and banker's rounding (ROUND_HALF_EVEN), which removes the systematic upward bias that
 * half-up rounding introduces across thousands of instalments.
 */
export const FinDecimal = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });
export type FinDecimal = InstanceType<typeof FinDecimal>;

/**
 * An amount in integer minor units of one currency. Immutable; arithmetic across currencies
 * is a programming error and throws.
 */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {}

  static of(minor: bigint, currency: CurrencyCode): Money {
    return new Money(minor, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  /** Round an arbitrary-precision decimal amount (already in minor units) to whole minor units. */
  static fromDecimalMinor(value: FinDecimal, currency: CurrencyCode): Money {
    return new Money(roundHalfEvenToBigInt(value), currency);
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  min(other: Money): Money {
    this.assertSame(other);
    return this.minor <= other.minor ? this : other;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  toDecimal(): FinDecimal {
    return new FinDecimal(this.minor.toString());
  }

  /** JSON shape used by the API: amounts as strings so no client parses them into a float. */
  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.minor.toString(), currency: this.currency };
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new BusinessRuleError(
        ErrorCode.CURRENCY_MISMATCH,
        `Cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}

/** Sum of bigints (minor units). */
export function sumMinor(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

/** Basis points of an amount, rounded half-even to minor units: amount × bps / 10 000. */
export function applyBps(minor: bigint, bps: number | bigint): bigint {
  return roundHalfEvenToBigInt(new FinDecimal(minor.toString()).mul(bps.toString()).div(10_000));
}

function roundHalfEvenToBigInt(value: FinDecimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
}
