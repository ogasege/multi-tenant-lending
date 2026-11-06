import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import { BusinessRuleError, NotFoundError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { assertIsoDate } from '../../lending/domain';
import { buildQuote } from '../domain/quote';
import { LoanProductsRepository, toTerms } from '../infrastructure/loan-products.repository';

export interface QuoteCommand {
  productId: string;
  principal: string;
  term: number;
  disbursementDate?: string;
}

export interface QuoteView {
  productId: string;
  productVersion: number;
  currency: string;
  principal: string;
  term: number;
  termUnit: 'DAYS' | 'INSTALMENTS';
  repaymentFrequency: string;
  interestMethod: string;
  annualInterestRateBps: number;
  disbursementDate: string;
  maturityDate: string;
  originationFee: string;
  originationFeeTreatment: string;
  financedPrincipal: string;
  netDisbursed: string;
  totalInterest: string;
  totalRepayable: string;
  totalCostOfCredit: string;
  aprBps: number;
  maxAprBps: number | null;
  aprWithinCap: boolean;
  instalments: {
    seq: number;
    dueDate: string;
    principal: string;
    interest: string;
    total: string;
  }[];
}

/** Today's calendar date in an IANA time zone, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Schedule + APR preview for a product's CURRENT version (SPEC §7.4 disclosure). Nothing is
 * persisted. Only ACTIVE products can be quoted (422 PRODUCT_NOT_ACTIVE).
 */
@Injectable()
export class QuoteLoanProduct {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
  ) {}

  async execute(cmd: QuoteCommand): Promise<QuoteView> {
    const { product, version, policy } = await this.runner.run(async (tx) => {
      const product = await this.repo.findProduct(tx, cmd.productId);
      if (!product) throw new NotFoundError('Loan product', cmd.productId);
      const version = await this.repo.findVersion(tx, product.id, product.current_version);
      const policy = await this.repo.institutionPolicy(tx);
      if (!version || !policy) throw new NotFoundError('Loan product', cmd.productId);
      return { product, version, policy };
    });
    if (product.status !== 'ACTIVE') {
      throw new BusinessRuleError(ErrorCode.PRODUCT_NOT_ACTIVE, 'This product is archived');
    }

    const disbursementDate = assertIsoDate(cmd.disbursementDate ?? todayIn(policy.timezone));
    const q = buildQuote(
      toTerms(version),
      { principal: BigInt(cmd.principal), term: cmd.term, disbursementDate },
      policy.maxAprBps,
    );

    return {
      productId: product.id,
      productVersion: version.version,
      currency: q.currency,
      principal: q.principal.toString(),
      term: q.term,
      termUnit: q.termUnit,
      repaymentFrequency: q.repaymentFrequency,
      interestMethod: q.interestMethod,
      annualInterestRateBps: q.annualInterestRateBps,
      disbursementDate: q.disbursementDate,
      maturityDate: q.maturityDate,
      originationFee: q.originationFee.toString(),
      originationFeeTreatment: q.originationFeeTreatment,
      financedPrincipal: q.financedPrincipal.toString(),
      netDisbursed: q.netDisbursed.toString(),
      totalInterest: q.totalInterest.toString(),
      totalRepayable: q.totalRepayable.toString(),
      totalCostOfCredit: q.totalCostOfCredit.toString(),
      aprBps: q.aprBps,
      maxAprBps: q.maxAprBps,
      aprWithinCap: q.aprWithinCap,
      instalments: q.instalments.map((i) => ({
        seq: i.seq,
        dueDate: i.dueDate,
        principal: i.principal.toString(),
        interest: i.interest.toString(),
        total: i.total.toString(),
      })),
    };
  }
}
