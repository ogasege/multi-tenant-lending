import { Injectable } from '@nestjs/common';

import type { TenantUser } from '../../../common/auth/decorators';
import type { Tx } from '../../../common/database/database.tokens';
import type { DpdBucket, LoanStatus } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/app-error';
import {
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  toPage,
} from '../../../common/http/pagination';
import { assertIsoDate, payoffQuote } from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';
import { type LoanRow, LoansRepository } from '../infrastructure/loans.repository';

import { businessDate } from './business-date';
import { ownCustomerScope } from './customer-scope';
import { toBalance } from './instalment-state';
import {
  type LoanView,
  type PayoffQuoteView,
  type RepaymentView,
  type ScheduleView,
  audienceOf,
  toInstalmentView,
  toLoanView,
  toRepaymentView,
} from './lending.views';
import { priceOffer } from './loan-offer';
import { Clock } from './ports/clock.port';

export interface LoanListQuery {
  limit?: number;
  cursor?: string;
  status?: LoanStatus;
  dpdBucket?: DpdBucket;
  minDaysPastDue?: number;
  customerId?: string;
}

/** Loads a loan the principal may see (a customer: own only) or throws 404. */
async function visibleLoan(
  tx: Tx,
  loans: LoansRepository,
  principal: TenantUser,
  id: string,
): Promise<LoanRow> {
  const own = await ownCustomerScope(tx, principal);
  const loan = await loans.find(tx, id, { customerId: own });
  if (!loan) throw new NotFoundError('Loan', id);
  return loan;
}

/** Loans newest first (keyset). Staff filter by status / DPD; a CUSTOMER sees only theirs. */
@Injectable()
export class ListLoans {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
  ) {}

  execute(principal: TenantUser, query: LoanListQuery): Promise<Page<LoanView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    return this.runner.run(async (tx) => {
      const own = await ownCustomerScope(tx, principal);
      const rows = await this.loans.list(tx, {
        limit,
        after: decodeCursor(query.cursor),
        status: query.status,
        dpdBucket: query.dpdBucket,
        minDaysPastDue: query.minDaysPastDue,
        customerId: own ?? query.customerId,
      });
      const page = rows.slice(0, limit);
      const instalments = await this.loans.instalmentsByLoan(
        tx,
        page.map((r) => r.id),
      );
      return toPage(rows, limit, (row) =>
        toLoanView(row, instalments.get(row.id) ?? [], audienceOf(principal)),
      );
    });
  }
}

/** One loan with its outstanding balances. */
@Injectable()
export class GetLoan {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
  ) {}

  execute(principal: TenantUser, id: string): Promise<LoanView> {
    return this.runner.run(async (tx) => {
      const loan = await visibleLoan(tx, this.loans, principal, id);
      return toLoanView(loan, await this.loans.instalments(tx, loan.id), audienceOf(principal));
    });
  }
}

/**
 * The repayment schedule. For a loan not yet disbursed it is a preview priced from the frozen
 * terms as if disbursed today (the real one is generated on the disbursement date).
 */
@Injectable()
export class GetLoanSchedule {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
    private readonly applications: ApplicationsRepository,
    private readonly clock: Clock,
  ) {}

  execute(principal: TenantUser, id: string): Promise<ScheduleView> {
    return this.runner.run(async (tx) => {
      const loan = await visibleLoan(tx, this.loans, principal, id);
      const instalments = await this.loans.instalments(tx, loan.id);
      if (loan.disbursement_date && loan.maturity_date) {
        return {
          loanId: loan.id,
          currency: loan.currency,
          preview: false,
          disbursementDate: loan.disbursement_date,
          maturityDate: loan.maturity_date,
          instalments: instalments.map(toInstalmentView),
        };
      }
      const { timezone } = await this.applications.institution(tx);
      const today = businessDate(timezone, this.clock.now());
      const { schedule } = priceOffer(loan.terms, loan.approved_principal, today);
      return {
        loanId: loan.id,
        currency: loan.currency,
        preview: true,
        disbursementDate: today,
        maturityDate: schedule.maturityDate,
        instalments: schedule.instalments.map((i) => ({
          seq: i.seq,
          dueDate: i.dueDate,
          principalDue: i.principal.toString(),
          interestDue: i.interest.toString(),
          feeDue: '0',
          penaltyDue: '0',
          principalPaid: '0',
          interestPaid: '0',
          feePaid: '0',
          penaltyPaid: '0',
          interestWaived: '0',
          totalDue: i.total.toString(),
          totalOutstanding: i.total.toString(),
          status: 'PENDING',
          paidAt: null,
        })),
      };
    });
  }
}

/**
 * Early-settlement payoff of an ACTIVE loan as of `asOf` (default: business today, not before
 * disbursement): outstanding principal + interest due by the later of `asOf` and business
 * today + fees and penalties; the interest of later instalments is waived (SPEC §7.5).
 */
@Injectable()
export class GetPayoffQuote {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
    private readonly applications: ApplicationsRepository,
    private readonly clock: Clock,
  ) {}

  execute(principal: TenantUser, id: string, asOfParam?: string): Promise<PayoffQuoteView> {
    return this.runner.run(async (tx) => {
      const loan = await visibleLoan(tx, this.loans, principal, id);
      if (loan.status !== 'ACTIVE' || !loan.disbursement_date) {
        throw new InvalidStateTransitionError('loan', loan.status, 'quote a payoff for');
      }
      const { timezone } = await this.applications.institution(tx);
      const today = businessDate(timezone, this.clock.now());
      const asOf = assertIsoDate(asOfParam ?? today);
      if (asOf < loan.disbursement_date) {
        throw new ValidationError('Request validation failed', [
          { field: 'asOf', message: `asOf must be on or after ${loan.disbursement_date}` },
        ]);
      }
      // Same rule as RecordRepayment: interest due by business today is never waivable, so a
      // past `asOf` quotes exactly what a settlement with that value date would accept.
      const q = payoffQuote((await this.loans.instalments(tx, loan.id)).map(toBalance), asOf, {
        earnedThrough: today,
      });
      return {
        loanId: loan.id,
        currency: loan.currency,
        asOf: q.asOf,
        principal: q.principal.toString(),
        interest: q.interest.toString(),
        fees: q.fees.toString(),
        penalties: q.penalties.toString(),
        total: q.total.toString(),
        waivedInterest: q.waivedInterest.toString(),
      };
    });
  }
}

/** Repayments of a loan, oldest first. */
@Injectable()
export class ListRepayments {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
  ) {}

  execute(principal: TenantUser, id: string): Promise<{ items: RepaymentView[] }> {
    return this.runner.run(async (tx) => {
      const loan = await visibleLoan(tx, this.loans, principal, id);
      return {
        items: (await this.loans.repayments(tx, loan.id)).map((r) =>
          toRepaymentView(r, audienceOf(principal)),
        ),
      };
    });
  }
}
