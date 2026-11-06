import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  AppError,
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { assertCurrency } from '../../../common/money/currency';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { LedgerService } from '../../ledger/application/ledger.service';
import { disbursementLines } from '../../ledger/domain/posting-rules';
import { generateSchedule, transition } from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';
import { LoansRepository } from '../infrastructure/loans.repository';

import { businessDate } from './business-date';
import { type LoanView, toLoanView } from './lending.views';
import { Clock } from './ports/clock.port';
import { PaymentGateway, PaymentProviderError } from './ports/payment-gateway.port';

/** 502: the payment provider refused the transfer; nothing was disbursed or posted. */
export class DisbursementProviderError extends AppError {
  constructor(reason: string) {
    super(502, ErrorCode.DISBURSEMENT_PROVIDER_FAILED, `Disbursement failed: ${reason}`);
  }
}

/**
 * Disburses an approved loan (SPEC §7.2, §8, §9).
 *
 * Locks the loan `FOR UPDATE` (concurrent disbursements serialise; the second one finds it
 * ACTIVE ⇒ 409), enforces maker-checker against the approver (403 SOD_VIOLATION) and the
 * approval's expiry (422 APPLICATION_EXPIRED), and pays the net amount to the payee through
 * the payment gateway. On success, in the same transaction: the schedule is generated from
 * the disbursement date (the institution's business "today"), instalments are stored, the
 * loan becomes ACTIVE, the DISBURSEMENT journal is posted (`disbursement:<loanId>`, at most
 * once), with audit and `loan.disbursed`. A provider rejection rolls everything back
 * (502 DISBURSEMENT_PROVIDER_FAILED): the loan stays PENDING_DISBURSEMENT, nothing posted.
 */
@Injectable()
export class DisburseLoan {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly loans: LoansRepository,
    private readonly applications: ApplicationsRepository,
    private readonly ledger: LedgerService,
    private readonly gateway: PaymentGateway,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
  ) {}

  execute(principal: TenantUser, loanId: string): Promise<LoanView> {
    return this.runner.run(async (tx) => {
      const loan = await this.loans.find(tx, loanId, { lock: 'wait' });
      if (!loan) throw new NotFoundError('Loan', loanId);
      if (loan.approved_by === principal.id) {
        throw new ForbiddenError(
          ErrorCode.SOD_VIOLATION,
          'The user who approved a loan cannot disburse it',
        );
      }
      const status = transition('loan', loan.status, 'disburse');

      const now = this.clock.now();
      const application = await this.applications.find(tx, loan.application_id);
      if (!application) throw new NotFoundError('Loan application', loan.application_id);
      if (application.expires_at && application.expires_at <= now) {
        throw new BusinessRuleError(
          ErrorCode.APPLICATION_EXPIRED,
          'The approval has expired; the application must be approved again',
          { expiresAt: application.expires_at.toISOString() },
        );
      }

      let providerReference: string;
      try {
        ({ providerReference } = await this.gateway.transfer({
          idempotencyKey: loan.id,
          amount: loan.net_disbursed,
          currency: loan.currency,
          payee: { type: loan.payee_type, name: loan.payee_name, account: loan.payee_account },
          narration: `Loan ${loan.reference}`,
        }));
      } catch (err) {
        if (err instanceof PaymentProviderError) throw new DisbursementProviderError(err.reason);
        throw err;
      }

      const institution = await this.applications.institution(tx);
      const disbursementDate = businessDate(institution.timezone, now);
      const schedule = generateSchedule({
        principal: loan.financed_principal,
        currency: assertCurrency(loan.currency),
        annualRateBps: loan.terms.annualInterestRateBps,
        term: loan.terms.term,
        frequency: loan.terms.repaymentFrequency,
        method: loan.terms.interestMethod,
        disbursementDate,
      });
      await this.loans.insertInstalments(
        tx,
        schedule.instalments.map((i) => ({
          tenant_id: loan.tenant_id,
          loan_id: loan.id,
          seq: i.seq,
          due_date: i.dueDate,
          principal_due: i.principal,
          interest_due: i.interest,
        })),
      );

      await this.ledger.post(tx, {
        kind: 'DISBURSEMENT',
        loanId: loan.id,
        currency: loan.currency,
        effectiveDate: disbursementDate,
        idempotencyRef: `disbursement:${loan.id}`,
        description: `Disbursement of ${loan.reference} to ${loan.payee_type.toLowerCase()} ${loan.payee_name}`,
        lines: disbursementLines({
          financedPrincipal: loan.financed_principal,
          netDisbursed: loan.net_disbursed,
          originationFee: loan.origination_fee,
        }),
      });

      const updated = await this.loans.update(tx, loan.id, {
        status,
        disbursed_by: principal.id,
        disbursed_at: now,
        disbursement_date: disbursementDate,
        maturity_date: schedule.maturityDate,
        provider_reference: providerReference,
      });
      const view = toLoanView(updated, await this.loans.instalments(tx, loan.id));

      await this.audit.record(tx, {
        action: 'loan.disbursed',
        entityType: 'loan',
        entityId: loan.id,
        before: { status: loan.status },
        after: {
          status,
          disbursementDate,
          maturityDate: schedule.maturityDate,
          netDisbursed: loan.net_disbursed,
          providerReference,
          payeeAccount: loan.payee_account,
        },
      });
      await this.outbox.publish(tx, {
        type: 'loan.disbursed',
        aggregateType: 'loan',
        aggregateId: loan.id,
        data: {
          loanId: loan.id,
          reference: loan.reference,
          applicationId: loan.application_id,
          externalOrderReference: application.external_order_reference,
          customerId: loan.customer_id,
          currency: loan.currency,
          approvedPrincipal: loan.approved_principal.toString(),
          financedPrincipal: loan.financed_principal.toString(),
          originationFee: loan.origination_fee.toString(),
          netDisbursed: loan.net_disbursed.toString(),
          payee: { type: loan.payee_type, name: loan.payee_name, account: loan.payee_account },
          providerReference,
          disbursementDate,
          maturityDate: schedule.maturityDate,
        },
      });
      return view;
    });
  }
}
