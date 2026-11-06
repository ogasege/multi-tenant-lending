import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { Tx } from '../../../common/database/database.tokens';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { LedgerService } from '../../ledger/application/ledger.service';
import { lateFeeLines } from '../../ledger/domain/posting-rules';
import { daysBetween, type IsoDate, lateFeeAmount, transition } from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';
import { type InstalmentRow, LoansRepository } from '../infrastructure/loans.repository';

import { outstandingTotal } from './instalment-state';
import { LoanAccounting } from './loan-accounting';

export interface LoanEndOfDayResult {
  /** False when the loan was locked by another transaction (left for the next run). */
  processed: boolean;
  interestAccruals: number;
  lateFees: number;
  dpdChanged: boolean;
}

export interface ExpiryResult {
  expired: boolean;
  loanCancelled: boolean;
}

/**
 * Per-loan end-of-day servicing, exported for the operations module (and the worker). Each
 * method runs in a transaction the caller opened for exactly one loan or application; locking
 * uses `FOR UPDATE SKIP LOCKED`, so a loan busy with a repayment is skipped, not waited on,
 * and picked up by the next (idempotent) run.
 */
@Injectable()
export class LoanServicing {
  constructor(
    private readonly loans: LoansRepository,
    private readonly applications: ApplicationsRepository,
    private readonly accounting: LoanAccounting,
    private readonly ledger: LedgerService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  activeLoanIds(tx: Tx): Promise<string[]> {
    return this.loans.activeLoanIds(tx);
  }

  /**
   * Approvals lapsed by the end of business day `asOf` AND already past their `expires_at`
   * at `now`: a run for a date whose end is still ahead never expires an approval early.
   */
  async lapsedApprovalIds(tx: Tx, asOf: IsoDate, now: Date): Promise<string[]> {
    const { timezone } = await this.applications.institution(tx);
    return this.loans.lapsedApprovalIds(tx, asOf, timezone, now);
  }

  /**
   * EOD for one ACTIVE loan as of `asOf` (SPEC §7.4, §8):
   *
   * 1. Interest of every instalment due on or before `asOf` not yet recognised is accrued
   *    (Dr 1110 / Cr 4000, ref `interest:<instalmentId>`).
   * 2. Every instalment still owing more than `graceDays` after its due date is charged the
   *    product late fee once (`lateFeeAmount` of its outstanding amount; penalty_due += fee;
   *    Dr 1130 / Cr 4200, ref `late-fee:<instalmentId>`; `late_fee_assessed`).
   * 3. Days past due and bucket are refreshed.
   *
   * Flags and journal refs make it idempotent: a second run for the same day changes nothing.
   */
  async endOfDayForLoan(
    tx: Tx,
    tenantId: string,
    loanId: string,
    asOf: IsoDate,
  ): Promise<LoanEndOfDayResult> {
    const result: LoanEndOfDayResult = {
      processed: false,
      interestAccruals: 0,
      lateFees: 0,
      dpdChanged: false,
    };
    const loan = await this.loans.find(tx, loanId, { lock: 'skip' });
    if (loan?.status !== 'ACTIVE') return result;
    result.processed = true;

    const instalments = await this.loans.instalments(tx, loan.id, { forUpdate: true });
    const fee = {
      type: loan.terms.lateFee.type,
      value: BigInt(loan.terms.lateFee.value),
    };
    const assessedFees: { seq: number; fee: string }[] = [];
    const current: InstalmentRow[] = [];
    for (const row of instalments) {
      if (row.due_date > asOf) {
        current.push(row);
        continue;
      }
      if ((await this.accounting.recogniseInterest(tx, loan, row, row.due_date)) > 0n) {
        result.interestAccruals++;
      }

      const owed = outstandingTotal(row);
      const lateBy = daysBetween(row.due_date, asOf);
      if (!row.late_fee_assessed && owed > 0n && lateBy > loan.terms.lateFee.graceDays) {
        const amount = lateFeeAmount(owed, fee);
        if (amount > 0n) {
          await this.ledger.post(tx, {
            kind: 'LATE_FEE',
            loanId: loan.id,
            currency: loan.currency,
            effectiveDate: asOf,
            idempotencyRef: `late-fee:${row.id}`,
            description: `Late fee on instalment ${row.seq} of ${loan.reference}`,
            lines: lateFeeLines(amount),
          });
          assessedFees.push({ seq: row.seq, fee: amount.toString() });
          result.lateFees++;
        }
        const penaltyDue = row.penalty_due + amount;
        await this.loans.updateInstalment(tx, row.id, {
          penalty_due: penaltyDue,
          late_fee_assessed: true,
        });
        current.push({ ...row, penalty_due: penaltyDue, late_fee_assessed: true });
      } else {
        current.push(row);
      }
    }

    const delinquency = await this.accounting.refreshDelinquency(tx, loan, current, asOf);
    result.dpdChanged = delinquency.changed;

    if (result.interestAccruals > 0 || assessedFees.length > 0 || delinquency.changed) {
      await this.audit.record(tx, {
        tenantId,
        action: 'loan.end_of_day',
        entityType: 'loan',
        entityId: loan.id,
        before: { daysPastDue: loan.days_past_due, dpdBucket: loan.dpd_bucket },
        after: {
          asOf,
          interestAccruals: result.interestAccruals,
          lateFees: assessedFees,
          daysPastDue: delinquency.daysPastDue,
          dpdBucket: delinquency.bucket,
        },
      });
    }
    for (const assessed of assessedFees) {
      await this.outbox.publish(tx, {
        tenantId,
        type: 'loan.late_fee_assessed',
        aggregateType: 'loan',
        aggregateId: loan.id,
        data: {
          loanId: loan.id,
          reference: loan.reference,
          currency: loan.currency,
          asOf,
          ...assessed,
        },
      });
    }
    if (delinquency.bucket !== loan.dpd_bucket) {
      await this.outbox.publish(tx, {
        tenantId,
        type: 'loan.delinquency_changed',
        aggregateType: 'loan',
        aggregateId: loan.id,
        data: {
          loanId: loan.id,
          reference: loan.reference,
          asOf,
          daysPastDue: delinquency.daysPastDue,
          dpdBucket: delinquency.bucket,
          previousBucket: loan.dpd_bucket,
        },
      });
    }
    return result;
  }

  /**
   * Expires an approval that was not disbursed in time (SPEC §7.2): application
   * APPROVED → EXPIRED and its loan PENDING_DISBURSEMENT → CANCELLED. Locks the loan first
   * (same order as disbursement), skipping it if a disbursement holds it; a loan that was
   * disbursed meanwhile is left alone, and so is one whose `expires_at` is still after `now`
   * (re-checked under the lock: the approval may have been renewed since it was listed).
   */
  async expireApproval(
    tx: Tx,
    tenantId: string,
    applicationId: string,
    now: Date,
  ): Promise<ExpiryResult> {
    const loan = await this.loans.findByApplication(tx, applicationId, { lock: 'skip' });
    if (loan?.status !== 'PENDING_DISBURSEMENT') return { expired: false, loanCancelled: false };
    const application = await this.applications.find(tx, applicationId, { forUpdate: true });
    if (application?.status !== 'APPROVED') return { expired: false, loanCancelled: false };
    if (!application.expires_at || application.expires_at > now) {
      return { expired: false, loanCancelled: false };
    }

    const appStatus = transition('application', application.status, 'expire');
    const loanStatus = transition('loan', loan.status, 'cancel');
    await this.applications.update(tx, application.id, { status: appStatus });
    await this.loans.update(tx, loan.id, { status: loanStatus });

    await this.audit.record(tx, {
      tenantId,
      action: 'loan_application.expired',
      entityType: 'loan_application',
      entityId: application.id,
      before: { status: application.status },
      after: { status: appStatus, expiresAt: application.expires_at },
    });
    await this.audit.record(tx, {
      tenantId,
      action: 'loan.cancelled',
      entityType: 'loan',
      entityId: loan.id,
      before: { status: loan.status },
      after: { status: loanStatus, reason: 'APPROVAL_EXPIRED' },
    });
    await this.outbox.publish(tx, {
      tenantId,
      type: 'loan_application.expired',
      aggregateType: 'loan_application',
      aggregateId: application.id,
      data: { applicationId: application.id, reference: application.reference, loanId: loan.id },
    });
    await this.outbox.publish(tx, {
      tenantId,
      type: 'loan.cancelled',
      aggregateType: 'loan',
      aggregateId: loan.id,
      data: { loanId: loan.id, reference: loan.reference, reason: 'APPROVAL_EXPIRED' },
    });
    return { expired: true, loanCancelled: true };
  }
}
