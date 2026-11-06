import { Injectable, Logger } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { ValidationError } from '../../../common/errors/app-error';
import { businessDate } from '../../lending/application/business-date';
import { LoanServicing } from '../../lending/application/loan-servicing.service';
import { Clock } from '../../lending/application/ports/clock.port';
import { assertIsoDate, type IsoDate } from '../../lending/domain';

export interface EndOfDaySummary {
  asOf: IsoDate;
  loansProcessed: number;
  /** Loans locked by a concurrent transaction; the next run picks them up. */
  loansSkipped: number;
  /** Loans whose processing failed (rolled back individually; see logs). */
  loansFailed: string[];
  /** Lapsed approvals whose expiry failed (rolled back individually; see logs). */
  applicationsFailed: string[];
  interestAccruals: number;
  lateFees: number;
  delinquencyUpdates: number;
  applicationsExpired: number;
  loansCancelled: number;
}

/**
 * End-of-day batch for one tenant (SPEC §7.4, §8, §10). Each loan — and each lapsed approval —
 * is processed in its OWN transaction, so one failure or one busy loan never rolls back or
 * blocks the rest, and locks are held for milliseconds. Idempotent by construction: per-
 * instalment flags plus unique journal refs (`interest:…`, `late-fee:…`) mean a re-run for
 * the same `asOf` posts nothing twice.
 *
 * {@link runForTenant} takes an explicit tenant so the worker can run it for every tenant;
 * the HTTP route runs it for the caller's tenant.
 */
@Injectable()
export class EndOfDayService {
  private readonly logger = new Logger(EndOfDayService.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly servicing: LoanServicing,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async runForTenant(tenantId: string, asOfParam: string): Promise<EndOfDaySummary> {
    const asOf = assertIsoDate(asOfParam);
    const now = this.clock.now();
    const { loanIds, approvalIds, today } = await this.runner.runForTenant(tenantId, async (tx) => {
      const institution = await tx
        .selectFrom('institutions')
        .select('timezone')
        .executeTakeFirstOrThrow();
      return {
        today: businessDate(institution.timezone, now),
        loanIds: await this.servicing.activeLoanIds(tx),
        approvalIds: await this.servicing.lapsedApprovalIds(tx, asOf, now),
      };
    });
    if (asOf > today) {
      throw new ValidationError('Request validation failed', [
        { field: 'asOf', message: `asOf cannot be after the business date ${today}` },
      ]);
    }

    const summary: EndOfDaySummary = {
      asOf,
      loansProcessed: 0,
      loansSkipped: 0,
      loansFailed: [],
      applicationsFailed: [],
      interestAccruals: 0,
      lateFees: 0,
      delinquencyUpdates: 0,
      applicationsExpired: 0,
      loansCancelled: 0,
    };

    for (const loanId of loanIds) {
      try {
        const r = await this.runner.runForTenant(tenantId, (tx) =>
          this.servicing.endOfDayForLoan(tx, tenantId, loanId, asOf),
        );
        if (!r.processed) {
          summary.loansSkipped++;
          continue;
        }
        summary.loansProcessed++;
        summary.interestAccruals += r.interestAccruals;
        summary.lateFees += r.lateFees;
        if (r.dpdChanged) summary.delinquencyUpdates++;
      } catch (err) {
        summary.loansFailed.push(loanId);
        this.logger.error(`EOD failed for loan ${loanId}: ${String(err)}`);
      }
    }

    for (const applicationId of approvalIds) {
      try {
        const r = await this.runner.runForTenant(tenantId, (tx) =>
          this.servicing.expireApproval(tx, tenantId, applicationId, now),
        );
        if (r.expired) summary.applicationsExpired++;
        if (r.loanCancelled) summary.loansCancelled++;
      } catch (err) {
        summary.applicationsFailed.push(applicationId);
        this.logger.error(`EOD expiry failed for application ${applicationId}: ${String(err)}`);
      }
    }

    await this.runner.runForTenant(tenantId, (tx) =>
      this.audit.record(tx, {
        tenantId,
        action: 'operations.end_of_day',
        entityType: 'institution',
        entityId: tenantId,
        after: summary,
      }),
    );
    return summary;
  }
}
