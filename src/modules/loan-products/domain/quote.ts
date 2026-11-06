import { BusinessRuleError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  computeAprBps,
  computeOrigination,
  generateSchedule,
  type IsoDate,
  type ScheduledInstalment,
  totalCostOfCredit,
} from '../../lending/domain';

import type { ProductTerms } from './product-terms';

export interface QuoteRequest {
  principal: bigint;
  term: number;
  disbursementDate: IsoDate;
}

/** Pre-contract disclosure for one hypothetical loan (FCCPC-style; nothing is persisted). */
export interface Quote {
  currency: string;
  principal: bigint;
  term: number;
  termUnit: 'DAYS' | 'INSTALMENTS';
  repaymentFrequency: ProductTerms['repaymentFrequency'];
  interestMethod: ProductTerms['interestMethod'] | 'SIMPLE';
  annualInterestRateBps: number;
  disbursementDate: IsoDate;
  maturityDate: IsoDate;
  originationFee: bigint;
  originationFeeTreatment: ProductTerms['originationFee']['treatment'];
  financedPrincipal: bigint;
  netDisbursed: bigint;
  totalInterest: bigint;
  totalRepayable: bigint;
  totalCostOfCredit: bigint;
  aprBps: number;
  maxAprBps: number | null;
  aprWithinCap: boolean;
  instalments: ScheduledInstalment[];
}

/**
 * Builds a quote from a product version's terms:
 *
 * 1. principal and term must lie inside the product's limits (422
 *    AMOUNT_OUT_OF_PRODUCT_RANGE / TERM_OUT_OF_PRODUCT_RANGE);
 * 2. origination fee on the requested principal — DEDUCTED lowers the cash disbursed,
 *    CAPITALISED raises the financed principal (SPEC §7.4);
 * 3. contractual schedule on the financed principal (SPEC §7.3);
 * 4. APR = annualised IRR of (net disbursed, instalments), so every fee is in it, and the
 *    total cost of credit = total repayable − net disbursed.
 *
 * The APR cap is reported (`aprWithinCap`) rather than enforced: a quote is a disclosure,
 * and the cap is enforced when a loan is approved.
 */
export function buildQuote(
  terms: ProductTerms,
  request: QuoteRequest,
  maxAprBps: number | null,
): Quote {
  const { principal, term, disbursementDate } = request;
  if (principal < terms.minPrincipal || principal > terms.maxPrincipal) {
    throw new BusinessRuleError(
      ErrorCode.AMOUNT_OUT_OF_PRODUCT_RANGE,
      `Principal must be between ${terms.minPrincipal} and ${terms.maxPrincipal} ${terms.currency} minor units`,
      { minPrincipal: terms.minPrincipal.toString(), maxPrincipal: terms.maxPrincipal.toString() },
    );
  }
  if (term < terms.minTerm || term > terms.maxTerm) {
    throw new BusinessRuleError(
      ErrorCode.TERM_OUT_OF_PRODUCT_RANGE,
      `Term must be between ${terms.minTerm} and ${terms.maxTerm}`,
      { minTerm: terms.minTerm, maxTerm: terms.maxTerm },
    );
  }

  const origination = computeOrigination(principal, terms.originationFee);
  const schedule = generateSchedule({
    principal: origination.financedPrincipal,
    currency: terms.currency,
    annualRateBps: terms.annualInterestRateBps,
    term,
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
  const bullet = terms.repaymentFrequency === 'BULLET';

  return {
    currency: terms.currency,
    principal,
    term,
    termUnit: bullet ? 'DAYS' : 'INSTALMENTS',
    repaymentFrequency: terms.repaymentFrequency,
    interestMethod: bullet ? 'SIMPLE' : terms.interestMethod,
    annualInterestRateBps: terms.annualInterestRateBps,
    disbursementDate,
    maturityDate: schedule.maturityDate,
    originationFee: origination.fee,
    originationFeeTreatment: terms.originationFee.treatment,
    financedPrincipal: origination.financedPrincipal,
    netDisbursed: origination.netDisbursed,
    totalInterest: schedule.totalInterest,
    totalRepayable: schedule.totalRepayable,
    totalCostOfCredit: totalCostOfCredit(schedule.totalRepayable, origination.netDisbursed),
    aprBps,
    maxAprBps,
    aprWithinCap: maxAprBps === null || aprBps <= maxAprBps,
    instalments: schedule.instalments,
  };
}

/** Reference disbursement date for product-level APR checks (APR is date-independent). */
const APR_REFERENCE_DATE: IsoDate = '2026-01-01';

/**
 * The highest all-in APR (interest + origination fee) a product's terms can produce. A
 * deducted or capitalised fee weighs most on the smallest principal (flat fees) and on the
 * shortest term (any fee, spread over the fewest periods), so the extremes are evaluated at
 * `minPrincipal` with both `minTerm` and `maxTerm` and the larger APR is returned.
 */
export function worstCaseAprBps(terms: ProductTerms): number {
  const termsToCheck = new Set([terms.minTerm, terms.maxTerm]);
  let worst = 0;
  for (const term of termsToCheck) {
    const { aprBps } = buildQuote(
      terms,
      { principal: terms.minPrincipal, term, disbursementDate: APR_REFERENCE_DATE },
      null,
    );
    worst = Math.max(worst, aprBps);
  }
  return worst;
}

/**
 * Rejects product terms whose worst-case all-in APR exceeds the institution's cap
 * (422 APR_EXCEEDS_CAP), so no loan the product allows could breach it. `null` = no cap.
 */
export function assertProductAprWithinCap(terms: ProductTerms, maxAprBps: number | null): void {
  if (maxAprBps === null) return;
  const aprBps = worstCaseAprBps(terms);
  if (aprBps > maxAprBps) {
    throw new BusinessRuleError(
      ErrorCode.APR_EXCEEDS_CAP,
      `The worst-case all-in APR of these terms (${aprBps} bps, at the minimum principal and ` +
        `term, fees included) exceeds the cap of ${maxAprBps} bps`,
      { aprBps, maxAprBps },
    );
  }
}
