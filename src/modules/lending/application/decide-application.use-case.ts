import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import type { Tx } from '../../../common/database/database.tokens';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { assertWithinAprCap, transition } from '../domain';
import {
  type ApplicationRow,
  ApplicationsRepository,
} from '../infrastructure/applications.repository';
import { LoansRepository } from '../infrastructure/loans.repository';
import { newReference } from '../infrastructure/references';

import { addDaysToInstant, businessDate } from './business-date';
import {
  type ApplicationView,
  type DisclosureView,
  type LoanView,
  toApplicationView,
  toLoanView,
} from './lending.views';
import { priceOffer, termsSnapshot } from './loan-offer';
import { Clock } from './ports/clock.port';

export interface ApprovalView {
  application: ApplicationView;
  loan: LoanView;
  disclosure: DisclosureView;
}

/** Maker-checker (SPEC §5): whoever submitted an application may not decide it. */
function assertNotSubmitter(application: ApplicationRow, principal: TenantUser): void {
  if (application.submitted_by === principal.id) {
    throw new ForbiddenError(
      ErrorCode.SOD_VIOLATION,
      'The user who submitted an application cannot decide it',
    );
  }
}

/** Without an explicit amount: the request, capped at a lower counter-offer. */
function defaultApprovedPrincipal(requested: bigint, counterOffer: bigint | null): bigint {
  return counterOffer !== null && counterOffer < requested ? counterOffer : requested;
}

async function lockApplication(
  repo: ApplicationsRepository,
  tx: Tx,
  id: string,
): Promise<ApplicationRow> {
  const row = await repo.find(tx, id, { forUpdate: true });
  if (!row) throw new NotFoundError('Loan application', id);
  return row;
}

/**
 * Approves an assessed application and books the loan PENDING_DISBURSEMENT (SPEC §7.2–7.4).
 *
 * 1. Maker-checker: the decider is not the submitter (403 SOD_VIOLATION).
 * 2. The latest assessment must exist (422 ASSESSMENT_REQUIRED) and not be DECLINE
 *    (422 ASSESSMENT_DECLINED); REFER is approvable by the officer's judgement.
 * 3. Approved principal (default: the request, or the max affordable amount for a
 *    COUNTER_OFFER) ≤ requested (422 APPROVED_AMOUNT_EXCEEDS_REQUEST), ≤ the counter-offer
 *    (422 APPROVED_AMOUNT_EXCEEDS_AFFORDABLE) and ≥ the product minimum.
 * 4. Fees and all-in APR are priced on the approved principal; the institution's usury cap
 *    applies to that APR (422 APR_EXCEEDS_CAP).
 * 5. The loan snapshots the version's terms and the payee; the approval lapses after the
 *    product's `application_expiry_days` if not disbursed.
 */
@Injectable()
export class ApproveApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly applications: ApplicationsRepository,
    private readonly loans: LoansRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
  ) {}

  execute(
    principal: TenantUser,
    id: string,
    cmd: { approvedPrincipal?: string; notes?: string },
  ): Promise<ApprovalView> {
    return this.runner.run(async (tx) => {
      const application = await lockApplication(this.applications, tx, id);
      assertNotSubmitter(application, principal);
      const assessment = await this.applications.latestAssessment(tx, id);
      if (!assessment || application.status === 'SUBMITTED') {
        throw new BusinessRuleError(
          ErrorCode.ASSESSMENT_REQUIRED,
          'The application must be assessed before it can be approved',
        );
      }
      const status = transition('application', application.status, 'approve');
      if (assessment.decision === 'DECLINE') {
        throw new BusinessRuleError(
          ErrorCode.ASSESSMENT_DECLINED,
          'The credit assessment declined this application; reject it instead',
          { reasonCodes: assessment.reason_codes },
        );
      }

      const counterOffer =
        assessment.decision === 'COUNTER_OFFER' ? assessment.max_affordable_principal : null;
      const requested = application.requested_principal;
      const approved =
        cmd.approvedPrincipal !== undefined
          ? BigInt(cmd.approvedPrincipal)
          : defaultApprovedPrincipal(requested, counterOffer);
      if (approved > requested) {
        throw new BusinessRuleError(
          ErrorCode.APPROVED_AMOUNT_EXCEEDS_REQUEST,
          'The approved principal cannot exceed the requested principal',
          { requestedPrincipal: requested.toString() },
        );
      }
      if (counterOffer !== null && approved > counterOffer) {
        throw new BusinessRuleError(
          ErrorCode.APPROVED_AMOUNT_EXCEEDS_AFFORDABLE,
          'The approved principal exceeds the maximum affordable principal of the assessment',
          { maxAffordablePrincipal: counterOffer.toString() },
        );
      }

      const { product, version } = await this.applications.versionWithProduct(
        tx,
        application.product_version_id,
      );
      if (approved < version.min_principal) {
        throw new BusinessRuleError(
          ErrorCode.AMOUNT_OUT_OF_PRODUCT_RANGE,
          `The approved principal must be at least ${version.min_principal}`,
          { minPrincipal: version.min_principal.toString() },
        );
      }
      const institution = await this.applications.institution(tx);
      const now = this.clock.now();
      const terms = termsSnapshot(product, version, application.term);
      const offer = priceOffer(terms, approved, businessDate(institution.timezone, now));
      assertWithinAprCap(offer.aprBps, institution.maxAprBps);

      const loanRow = await this.loans.insert(tx, {
        tenant_id: principal.tenantId,
        reference: newReference('LN'),
        application_id: application.id,
        customer_id: application.customer_id,
        product_version_id: version.id,
        currency: application.currency,
        approved_principal: approved,
        financed_principal: offer.origination.financedPrincipal,
        origination_fee: offer.origination.fee,
        net_disbursed: offer.origination.netDisbursed,
        terms: JSON.stringify(terms),
        payee_type: application.payee_type,
        payee_name: application.payee_name,
        payee_account: application.payee_account,
        apr_bps: offer.aprBps,
        status: 'PENDING_DISBURSEMENT',
        approved_by: principal.id,
        approved_at: now,
      });
      const updated = await this.applications.update(tx, id, {
        status,
        decided_by: principal.id,
        decided_at: now,
        decision_notes: cmd.notes?.trim() ?? null,
        approved_principal: approved,
        expires_at: addDaysToInstant(now, version.application_expiry_days),
      });
      const view: ApprovalView = {
        application: toApplicationView(updated, loanRow.id),
        loan: toLoanView(loanRow, []),
        disclosure: offer.disclosure,
      };

      await this.audit.record(tx, {
        action: 'loan_application.approved',
        entityType: 'loan_application',
        entityId: id,
        before: { status: application.status },
        after: {
          status,
          approvedPrincipal: approved,
          loanId: loanRow.id,
          aprBps: offer.aprBps,
          expiresAt: updated.expires_at,
        },
      });
      await this.audit.record(tx, {
        action: 'loan.created',
        entityType: 'loan',
        entityId: loanRow.id,
        after: view.loan,
      });
      await this.outbox.publish(tx, {
        type: 'loan_application.approved',
        aggregateType: 'loan_application',
        aggregateId: id,
        data: {
          applicationId: id,
          reference: updated.reference,
          customerId: updated.customer_id,
          loanId: loanRow.id,
          loanReference: loanRow.reference,
          currency: loanRow.currency,
          approvedPrincipal: approved.toString(),
          financedPrincipal: loanRow.financed_principal.toString(),
          netDisbursed: loanRow.net_disbursed.toString(),
          aprBps: offer.aprBps,
          expiresAt: updated.expires_at?.toISOString() ?? null,
        },
      });
      return view;
    });
  }
}

/**
 * Rejects a SUBMITTED or ASSESSED application with adverse-action reason codes (SPEC §7.6).
 * Maker-checker applies as for approval (403 SOD_VIOLATION).
 */
@Injectable()
export class RejectApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly applications: ApplicationsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
  ) {}

  execute(
    principal: TenantUser,
    id: string,
    cmd: { reasonCodes: string[]; notes?: string },
  ): Promise<ApplicationView> {
    return this.runner.run(async (tx) => {
      const application = await lockApplication(this.applications, tx, id);
      assertNotSubmitter(application, principal);
      const status = transition('application', application.status, 'reject');
      const reasonCodes = [...new Set(cmd.reasonCodes)];
      const updated = await this.applications.update(tx, id, {
        status,
        decided_by: principal.id,
        decided_at: this.clock.now(),
        decision_notes: cmd.notes?.trim() ?? null,
        rejection_reason_codes: reasonCodes,
      });

      await this.audit.record(tx, {
        action: 'loan_application.rejected',
        entityType: 'loan_application',
        entityId: id,
        before: { status: application.status },
        after: { status, reasonCodes },
      });
      await this.outbox.publish(tx, {
        type: 'loan_application.rejected',
        aggregateType: 'loan_application',
        aggregateId: id,
        data: {
          applicationId: id,
          reference: updated.reference,
          customerId: updated.customer_id,
          reasonCodes,
        },
      });
      return toApplicationView(updated, null);
    });
  }
}
