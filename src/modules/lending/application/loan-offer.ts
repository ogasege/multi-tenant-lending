import type { LoanTermsSnapshot } from '../../../common/database/schema';
import { assertCurrency } from '../../../common/money/currency';
import {
  computeAprBps,
  computeOrigination,
  generateSchedule,
  type IsoDate,
  type OriginationAmounts,
  type Schedule,
  totalCostOfCredit,
} from '../domain';
import type { ProductRow, VersionRow } from '../infrastructure/applications.repository';

import type { DisclosureView } from './lending.views';

/** Frozen copy of a product version's terms for one application term (`loans.terms`). */
export function termsSnapshot(
  product: ProductRow,
  version: VersionRow,
  term: number,
): LoanTermsSnapshot {
  return {
    productId: product.id,
    productVersionId: version.id,
    productVersion: version.version,
    productCode: product.code,
    currency: version.currency,
    term,
    repaymentFrequency: version.repayment_frequency,
    interestMethod: version.interest_method,
    annualInterestRateBps: version.annual_interest_rate_bps,
    dayCount: version.day_count,
    originationFee: {
      type: version.origination_fee_type,
      value: version.origination_fee_value.toString(),
      treatment: version.origination_fee_treatment,
    },
    lateFee: {
      type: version.late_fee_type,
      value: version.late_fee_value.toString(),
      graceDays: version.late_fee_grace_days,
    },
  };
}

export interface LoanOffer {
  origination: OriginationAmounts;
  schedule: Schedule;
  aprBps: number;
  disclosure: DisclosureView;
}

/**
 * Prices a principal under fixed terms as if disbursed on `disbursementDate`: origination fee
 * and its treatment (SPEC §7.4), the contractual schedule on the financed principal (§7.3),
 * the all-in APR (net disbursed vs instalments, so every fee is in it) and the FCCPC-style
 * disclosure (instalment, total repayable, total cost of credit = repayable − net disbursed).
 */
export function priceOffer(
  terms: LoanTermsSnapshot,
  principal: bigint,
  disbursementDate: IsoDate,
): LoanOffer {
  const currency = assertCurrency(terms.currency);
  const origination = computeOrigination(principal, {
    type: terms.originationFee.type,
    value: BigInt(terms.originationFee.value),
    treatment: terms.originationFee.treatment,
  });
  const schedule = generateSchedule({
    principal: origination.financedPrincipal,
    currency,
    annualRateBps: terms.annualInterestRateBps,
    term: terms.term,
    frequency: terms.repaymentFrequency,
    method: terms.interestMethod,
    disbursementDate,
  });
  const aprBps = computeAprBps({
    netDisbursed: origination.netDisbursed,
    disbursementDate,
    frequency: terms.repaymentFrequency,
    instalments: schedule.instalments,
  });
  const first = schedule.instalments[0];
  return {
    origination,
    schedule,
    aprBps,
    disclosure: {
      currency,
      principal: principal.toString(),
      originationFee: origination.fee.toString(),
      originationFeeTreatment: terms.originationFee.treatment,
      financedPrincipal: origination.financedPrincipal.toString(),
      netDisbursed: origination.netDisbursed.toString(),
      numberOfInstalments: schedule.instalments.length,
      instalmentAmount: (first?.total ?? 0n).toString(),
      totalInterest: schedule.totalInterest.toString(),
      totalRepayable: schedule.totalRepayable.toString(),
      totalCostOfCredit: totalCostOfCredit(
        schedule.totalRepayable,
        origination.netDisbursed,
      ).toString(),
      aprBps,
      firstDueDate: first?.dueDate ?? schedule.maturityDate,
      maturityDate: schedule.maturityDate,
    },
  };
}
