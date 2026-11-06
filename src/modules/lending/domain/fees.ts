import type { FeeTreatment, FeeType } from '../../../common/database/schema';
import { ValidationError } from '../../../common/errors/app-error';
import { applyBps } from '../../../common/money/money';

/**
 * A fee definition as stored on a product version: FLAT ⇒ `value` is minor units;
 * PERCENTAGE ⇒ `value` is basis points of the base amount; NONE ⇒ no fee.
 */
export interface FeeSpec {
  type: FeeType;
  value: bigint;
}

export interface OriginationFeeSpec extends FeeSpec {
  treatment: FeeTreatment;
}

export interface OriginationAmounts {
  /** Principal approved by the lender (what the customer asked for / was offered). */
  approvedPrincipal: bigint;
  fee: bigint;
  /** Principal the schedule amortises: approved (+ fee when CAPITALISED). */
  financedPrincipal: bigint;
  /** Cash that leaves the lender at disbursement: approved (− fee when DEDUCTED). */
  netDisbursed: bigint;
}

/**
 * Fee amount for a base amount: NONE ⇒ 0; FLAT ⇒ `value`; PERCENTAGE ⇒
 * `base × value / 10 000` rounded half-even to minor units.
 */
export function feeAmount(base: bigint, spec: FeeSpec): bigint {
  if (spec.value < 0n) {
    throw new ValidationError('Fee value must be non-negative', [
      { field: 'fee.value', message: 'must be >= 0' },
    ]);
  }
  switch (spec.type) {
    case 'NONE':
      return 0n;
    case 'FLAT':
      return spec.value;
    case 'PERCENTAGE':
      return applyBps(base, spec.value);
  }
}

/**
 * Origination fee and its treatment (SPEC §7.4). The fee is always computed on the
 * APPROVED principal.
 *
 * - DEDUCTED: financed = approved, netDisbursed = approved − fee.
 * - CAPITALISED: financed = approved + fee, netDisbursed = approved.
 *
 * The fee must be strictly less than the approved principal (otherwise a DEDUCTED fee
 * would disburse nothing).
 */
export function computeOrigination(
  approvedPrincipal: bigint,
  spec: OriginationFeeSpec,
): OriginationAmounts {
  if (approvedPrincipal <= 0n) {
    throw new ValidationError('Approved principal must be positive', [
      { field: 'approvedPrincipal', message: 'must be > 0' },
    ]);
  }
  const fee = feeAmount(approvedPrincipal, spec);
  if (fee >= approvedPrincipal) {
    throw new ValidationError('Origination fee must be less than the approved principal', [
      { field: 'originationFee', message: 'must be < approved principal' },
    ]);
  }
  return spec.treatment === 'DEDUCTED'
    ? {
        approvedPrincipal,
        fee,
        financedPrincipal: approvedPrincipal,
        netDisbursed: approvedPrincipal - fee,
      }
    : {
        approvedPrincipal,
        fee,
        financedPrincipal: approvedPrincipal + fee,
        netDisbursed: approvedPrincipal,
      };
}

/**
 * Late fee for one overdue instalment (assessed once, after `grace_days`, by EOD):
 * FLAT ⇒ `value`; PERCENTAGE ⇒ `value` bps of the overdue instalment amount (half-even).
 */
export function lateFeeAmount(overdueInstalmentAmount: bigint, spec: FeeSpec): bigint {
  if (overdueInstalmentAmount < 0n) {
    throw new ValidationError('Overdue amount must be non-negative', [
      { field: 'overdueInstalmentAmount', message: 'must be >= 0' },
    ]);
  }
  return feeAmount(overdueInstalmentAmount, spec);
}
