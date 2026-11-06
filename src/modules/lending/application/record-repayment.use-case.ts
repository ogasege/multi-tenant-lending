import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import type { Tx } from '../../../common/database/database.tokens';
import type { RepaymentChannel } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import { LedgerService } from '../../ledger/application/ledger.service';
import { repaymentLines } from '../../ledger/domain/posting-rules';
import {
  addDays,
  allocateRepayment,
  assertIsoDate,
  type IsoDate,
  payoffQuote,
  settlementWaivers,
  transition,
} from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';
import { type LoanRow, LoansRepository } from '../infrastructure/loans.repository';

import { businessDate } from './business-date';
import {
  outstandingSummary,
  paymentColumnsChanged,
  toBalance,
  withAllocation,
  withWaivers,
} from './instalment-state';
import { LoanAccounting } from './loan-accounting';
import { type RepaymentResultView, toOutstandingView, toRepaymentView } from './lending.views';
import { Clock } from './ports/clock.port';

export interface RecordRepaymentCommand {
  amount: string;
  channel: RepaymentChannel;
  externalReference?: string;
  valueDate?: string;
}

/**
 * Records a repayment that a FINANCE_OFFICER has confirmed was received (SPEC §7.5, §8, §9).
 *
 * Staff only: a borrower recording their own repayment would be self-attested money-in (a
 * customer could "repay" without paying and close the loan), so the CUSTOMER role is refused
 * (403 from the guard, and again here defensively). In production a customer-initiated
 * payment is a PENDING payment intent; it is allocated and posted to the ledger only after
 * a verified payment-provider confirmation (signed webhook, or a lookup of the provider
 * reference), by the same allocation logic as below.
 *
 * Locks the loan, then its instalments (fixed lock order), so concurrent repayments on one
 * loan serialise and each one allocates against the balances the previous one left: they can
 * never over-allocate.
 *
 * Value date (default: business today) must lie within [latest of: disbursement date, the
 * latest recorded repayment's value date, business today − REPAYMENT_MAX_BACKDATE_DAYS;
 * business today], else 422 VALUE_DATE_OUT_OF_RANGE: payments are recorded in value-date
 * order, never in the future, and only a short, configurable window back. A statement-backed
 * channel (anything but CASH) requires its `externalReference` (422
 * EXTERNAL_REFERENCE_REQUIRED), unique per institution (409 DUPLICATE), so one statement line
 * can never be posted twice. Then, as of the value date:
 *
 * - amount > payoff ⇒ 422 REPAYMENT_EXCEEDS_PAYOFF;
 * - amount = payoff ⇒ early settlement: interest of instalments due after business today
 *   (unearned) is waived first, then the waterfall clears every component and the loan
 *   CLOSES. Interest already due as of business today is never waived, even when the value
 *   date is earlier (a backdated settlement cannot wipe interest EOD has recognised);
 * - otherwise the waterfall: oldest instalment first, penalties → fees → interest → principal.
 *
 * Interest a payment reaches before EOD has recognised it is accrued first, so the interest
 * receivable is never credited below zero. Posts the REPAYMENT journal by allocation
 * (`repayment:<id>`), updates instalments, stores the repayment, refreshes DPD, with audit,
 * `loan.repayment_received` and, on closure, `loan.closed` — all in one transaction.
 */
@Injectable()
export class RecordRepayment {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
    private readonly applications: ApplicationsRepository,
    private readonly accounting: LoanAccounting,
    private readonly ledger: LedgerService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  execute(
    principal: TenantUser,
    loanId: string,
    cmd: RecordRepaymentCommand,
  ): Promise<RepaymentResultView> {
    if (principal.role === 'CUSTOMER') {
      return Promise.reject(
        new ForbiddenError(undefined, 'Repayments are recorded by the institution'),
      );
    }
    return this.runner.run(async (tx) => {
      const loan = await this.loans.find(tx, loanId, { lock: 'wait' });
      if (!loan) throw new NotFoundError('Loan', loanId);
      if (loan.status !== 'ACTIVE' || !loan.disbursement_date) {
        throw new InvalidStateTransitionError('loan', loan.status, 'repay');
      }

      const { timezone } = await this.applications.institution(tx);
      const today = businessDate(timezone, this.clock.now());
      const valueDate = assertIsoDate(cmd.valueDate ?? today);
      await this.assertValueDateInRange(tx, loan, valueDate, today);
      if (cmd.externalReference === undefined && cmd.channel !== 'CASH') {
        throw new BusinessRuleError(
          ErrorCode.EXTERNAL_REFERENCE_REQUIRED,
          `externalReference is required for ${cmd.channel} repayments (only CASH may omit it)`,
          { channel: cmd.channel },
        );
      }
      if (
        cmd.externalReference !== undefined &&
        (await this.loans.externalReferenceExists(tx, cmd.externalReference))
      ) {
        throw new ConflictError(
          ErrorCode.DUPLICATE,
          'A repayment with this external reference was already recorded',
        );
      }

      const amount = BigInt(cmd.amount);
      const instalments = await this.loans.instalments(tx, loan.id, { forUpdate: true });
      // Interest due up to business today is earned whatever the value date (SPEC §7.5).
      const earned = { earnedThrough: today };
      const payoff = payoffQuote(instalments.map(toBalance), valueDate, earned);
      if (amount > payoff.total) {
        throw new BusinessRuleError(
          ErrorCode.REPAYMENT_EXCEEDS_PAYOFF,
          `The amount exceeds the payoff amount of ${payoff.total} ${loan.currency} minor units`,
          { payoffAmount: payoff.total.toString(), asOf: valueDate },
        );
      }

      const settling = amount === payoff.total;
      const waivers = settling
        ? settlementWaivers(instalments.map(toBalance), valueDate, earned)
        : [];
      const waived = withWaivers(instalments, waivers);
      const allocation = allocateRepayment(amount, waived.map(toBalance));
      const after = withAllocation(waived, allocation);

      // Recognise interest the payment reaches before EOD did; reverse recognised interest
      // that settlement waives. Both leave Interest Receivable exactly at what is owed.
      for (const a of allocation.allocations) {
        const row = waived.find((r) => r.seq === a.seq);
        if (row && a.interest > 0n) {
          await this.accounting.recogniseInterest(tx, loan, row, valueDate);
        }
      }
      for (const w of waivers) {
        const row = instalments.find((r) => r.seq === w.seq);
        if (row) {
          await this.accounting.reverseWaivedInterest(tx, loan, row, w.interestWaived, valueDate);
        }
      }

      const repaymentId = randomUUID();
      const { journalEntryId } = await this.ledger.post(tx, {
        kind: 'REPAYMENT',
        loanId: loan.id,
        currency: loan.currency,
        effectiveDate: valueDate,
        idempotencyRef: `repayment:${repaymentId}`,
        description: `Repayment on ${loan.reference} via ${cmd.channel}`,
        lines: repaymentLines(allocation.totals),
      });

      const now = this.clock.now();
      for (const row of after) {
        const before = instalments.find((r) => r.id === row.id);
        if (before && paymentColumnsChanged(before, row)) {
          await this.loans.updateInstalment(tx, row.id, {
            principal_paid: row.principal_paid,
            interest_paid: row.interest_paid,
            fee_paid: row.fee_paid,
            penalty_paid: row.penalty_paid,
            interest_waived: row.interest_waived,
            status: row.status,
            paid_at: row.status === 'PAID' ? now : null,
          });
        }
      }

      const repayment = await this.loans.insertRepayment(tx, {
        id: repaymentId,
        tenant_id: loan.tenant_id,
        loan_id: loan.id,
        amount,
        currency: loan.currency,
        value_date: valueDate,
        channel: cmd.channel,
        external_reference: cmd.externalReference ?? null,
        allocated_principal: allocation.totals.principal,
        allocated_interest: allocation.totals.interest,
        allocated_fee: allocation.totals.fee,
        allocated_penalty: allocation.totals.penalty,
        journal_entry_id: journalEntryId,
        recorded_by: principal.id,
      });

      const remaining = outstandingSummary(after);
      const closes = remaining.total === 0n;
      const delinquency = await this.accounting.refreshDelinquency(tx, loan, after, today);
      const loanStatus = closes ? transition('loan', loan.status, 'settle') : loan.status;
      if (closes) await this.loans.update(tx, loan.id, { status: loanStatus, closed_at: now });

      const view = toRepaymentView(repayment);
      const waivedInterest = waivers.reduce((acc, w) => acc + w.interestWaived, 0n);
      await this.audit.record(tx, {
        action: 'loan.repayment_received',
        entityType: 'loan',
        entityId: loan.id,
        before: { status: loan.status, payoff: payoff.total },
        after: { repayment: view, waivedInterest, status: loanStatus },
      });
      await this.outbox.publish(tx, {
        type: 'loan.repayment_received',
        aggregateType: 'loan',
        aggregateId: loan.id,
        data: {
          loanId: loan.id,
          reference: loan.reference,
          repaymentId,
          currency: loan.currency,
          amount: amount.toString(),
          valueDate,
          channel: cmd.channel,
          allocation: view.allocation,
          outstanding: remaining.total.toString(),
        },
      });
      if (closes) {
        await this.audit.record(tx, {
          action: 'loan.closed',
          entityType: 'loan',
          entityId: loan.id,
          before: { status: loan.status },
          after: { status: loanStatus, waivedInterest },
        });
        await this.outbox.publish(tx, {
          type: 'loan.closed',
          aggregateType: 'loan',
          aggregateId: loan.id,
          data: {
            loanId: loan.id,
            reference: loan.reference,
            closedAt: now.toISOString(),
            waivedInterest: waivedInterest.toString(),
          },
        });
      }

      return {
        ...view,
        settled: closes,
        waivedInterest: waivedInterest.toString(),
        loanStatus,
        daysPastDue: delinquency.daysPastDue,
        outstanding: toOutstandingView(after),
      };
    });
  }

  /** 422 VALUE_DATE_OUT_OF_RANGE unless `valueDate` lies in the window documented above. */
  private async assertValueDateInRange(
    tx: Tx,
    loan: LoanRow,
    valueDate: IsoDate,
    today: IsoDate,
  ): Promise<void> {
    const bounds: IsoDate[] = [
      addDays(today, -this.config.REPAYMENT_MAX_BACKDATE_DAYS),
      loan.disbursement_date ?? today,
    ];
    const latest = await this.loans.latestRepaymentValueDate(tx, loan.id);
    if (latest !== undefined) bounds.push(latest);
    const earliest = bounds.reduce((a, b) => (a > b ? a : b));
    if (valueDate < earliest || valueDate > today) {
      throw new BusinessRuleError(
        ErrorCode.VALUE_DATE_OUT_OF_RANGE,
        `valueDate must be between ${earliest} and ${today}`,
        { earliestValueDate: earliest, latestValueDate: today },
      );
    }
  }
}
