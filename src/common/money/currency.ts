import { BusinessRuleError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

/**
 * ISO 4217 minor-unit exponents for the currencies the platform supports.
 * NGN (Nigeria) and XOF (Senegal / WAEMU) are the launch markets; XOF has NO minor unit,
 * which is exactly why the exponent is data and never assumed to be 2.
 */
export const CURRENCY_EXPONENT = {
  NGN: 2,
  XOF: 0,
  GHS: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENT;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(CURRENCY_EXPONENT, code);
}

export function assertCurrency(code: string): CurrencyCode {
  if (!isSupportedCurrency(code)) {
    throw new BusinessRuleError(
      ErrorCode.UNSUPPORTED_CURRENCY,
      `Currency ${code} is not supported`,
    );
  }
  return code;
}

export function exponentOf(code: CurrencyCode): number {
  return CURRENCY_EXPONENT[code];
}
