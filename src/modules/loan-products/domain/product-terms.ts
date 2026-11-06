import type {
  FeeTreatment,
  FeeType,
  InterestMethod,
  PayeeType,
  RepaymentFrequency,
} from '../../../common/database/schema';
import {
  BusinessRuleError,
  type FieldError,
  ValidationError,
} from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { assertWithinAprCap } from '../../lending/domain';
import { type CurrencyCode, isSupportedCurrency } from '../../../common/money/currency';

/** The economic terms of one immutable product version (money in minor units). */
export interface ProductTerms {
  currency: CurrencyCode;
  minPrincipal: bigint;
  maxPrincipal: bigint;
  /** Instalment count, or tenor in DAYS when `repaymentFrequency` is BULLET. */
  minTerm: number;
  maxTerm: number;
  repaymentFrequency: RepaymentFrequency;
  /** Ignored for BULLET, which always charges simple interest at maturity. */
  interestMethod: InterestMethod;
  annualInterestRateBps: number;
  dayCount: 'ACT_365F';
  originationFee: { type: FeeType; value: bigint; treatment: FeeTreatment };
  lateFee: { type: FeeType; value: bigint; graceDays: number };
  maxDtiBps: number;
  minCreditScore: number;
  applicationExpiryDays: number;
  disbursementMode: PayeeType;
}

/** Terms as received from a client, before cross-field validation. */
export type ProductTermsInput = Omit<ProductTerms, 'currency' | 'dayCount'> & { currency: string };

/**
 * Allowed `term` range per frequency. BULLET tenors are days (7–365, typical inventory
 * finance); instalment products are capped at 30 years of monthly payments or the
 * equivalent span, which bounds schedule size (and therefore quote cost).
 */
export const TERM_LIMITS: Readonly<Record<RepaymentFrequency, { min: number; max: number }>> = {
  BULLET: { min: 7, max: 365 },
  DAILY: { min: 1, max: 365 },
  WEEKLY: { min: 1, max: 520 },
  BIWEEKLY: { min: 1, max: 260 },
  MONTHLY: { min: 1, max: 360 },
};

/** Basis points are capped at 100 % for percentage fees. */
const MAX_PERCENT_BPS = 10_000n;

export interface InstitutionLimits {
  supportedCurrencies: readonly string[];
  /** Regulatory APR ceiling in bps (`null` = none). */
  maxAprBps: number | null;
}

function feeErrors(
  field: string,
  fee: { type: FeeType; value: bigint },
  minPrincipal: bigint,
): FieldError[] {
  if (fee.type === 'NONE' && fee.value !== 0n) {
    return [{ field: `${field}.value`, message: 'must be 0 when type is NONE' }];
  }
  if (fee.type === 'PERCENTAGE' && fee.value > MAX_PERCENT_BPS) {
    return [{ field: `${field}.value`, message: 'percentage fees are bps and must be ≤ 10000' }];
  }
  if (field === 'originationFee' && fee.type === 'FLAT' && fee.value >= minPrincipal) {
    return [{ field: `${field}.value`, message: 'flat fee must be less than minPrincipal' }];
  }
  if (field === 'originationFee' && fee.type === 'PERCENTAGE' && fee.value >= MAX_PERCENT_BPS) {
    return [{ field: `${field}.value`, message: 'must be < 10000 bps' }];
  }
  return [];
}

/**
 * Validates a set of product terms against each other and against the institution:
 *
 * - ranges are ordered and inside {@link TERM_LIMITS} for the frequency (400);
 * - fee values are consistent with their type, and an origination fee can never consume
 *   the whole minimum principal (400);
 * - the currency is one the platform knows and the institution offers (422
 *   UNSUPPORTED_CURRENCY);
 * - the nominal rate does not exceed the institution's APR cap (422 APR_EXCEEDS_CAP). The
 *   use cases then also check the worst-case ALL-IN APR (fees included, at the minimum
 *   principal and term) with `assertProductAprWithinCap`; approval re-checks per loan.
 */
export function validateProductTerms(
  input: ProductTermsInput,
  institution: InstitutionLimits,
): ProductTerms {
  const errors: FieldError[] = [];
  if (input.maxPrincipal < input.minPrincipal) {
    errors.push({ field: 'maxPrincipal', message: 'must be ≥ minPrincipal' });
  }
  if (input.maxTerm < input.minTerm) {
    errors.push({ field: 'maxTerm', message: 'must be ≥ minTerm' });
  }
  const limits = TERM_LIMITS[input.repaymentFrequency];
  const unit = input.repaymentFrequency === 'BULLET' ? 'days' : 'instalments';
  for (const field of ['minTerm', 'maxTerm'] as const) {
    if (input[field] < limits.min || input[field] > limits.max) {
      errors.push({
        field,
        message: `must be ${limits.min}–${limits.max} ${unit} for ${input.repaymentFrequency}`,
      });
    }
  }
  errors.push(...feeErrors('originationFee', input.originationFee, input.minPrincipal));
  errors.push(...feeErrors('lateFee', input.lateFee, input.minPrincipal));
  if (errors.length > 0) throw new ValidationError('Invalid product terms', errors);

  const { currency } = input;
  if (!isSupportedCurrency(currency) || !institution.supportedCurrencies.includes(currency)) {
    throw new BusinessRuleError(
      ErrorCode.UNSUPPORTED_CURRENCY,
      `Currency ${currency} is not offered by this institution`,
      { supportedCurrencies: institution.supportedCurrencies },
    );
  }
  assertWithinAprCap(input.annualInterestRateBps, institution.maxAprBps);

  return { ...input, currency, dayCount: 'ACT_365F' };
}
