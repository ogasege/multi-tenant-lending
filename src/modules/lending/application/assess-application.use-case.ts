import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { assertCurrency } from '../../../common/money/currency';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import {
  assessCredit,
  type CreditAssessmentInput,
  type CreditBureauPort,
  transition,
} from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';
import { CREDIT_BUREAU } from '../infrastructure/providers';

import { businessDate } from './business-date';
import { type AssessmentView, toAssessmentView } from './lending.views';
import { priceOffer, termsSnapshot } from './loan-offer';
import { Clock } from './ports/clock.port';

/** JSON-safe copy of the scorecard input (bigints as strings) for the reproducibility record. */
function snapshotOf(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Credit assessment, model `scorecard-v1` (SPEC §7.6). Builds the scorecard input from the
 * customer profile (income, existing debt, owner date of birth, tenure, KYC), the
 * application's product version (rate, method, max DTI, min score), the worst DPD of the
 * customer's active loans at this tenant, and the bureau report for the national-id HMAC.
 * Affordability is tested on the FINANCED principal (requested + capitalised fee).
 *
 * Persists the decision with its full input snapshot (so it can be re-derived), reason codes,
 * grade, APR (incl. origination fee) and max affordable principal, moves the application to
 * ASSESSED (re-assessment allowed) and returns the FCCPC-style disclosure. A DECLINE does not
 * reject automatically: a credit officer records the rejection (maker-checker stays explicit).
 */
@Injectable()
export class AssessApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: ApplicationsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    @Inject(CREDIT_BUREAU) private readonly bureau: CreditBureauPort,
  ) {}

  execute(principal: TenantUser, id: string): Promise<AssessmentView> {
    return this.runner.run(async (tx) => {
      const application = await this.repo.find(tx, id, { forUpdate: true });
      if (!application) throw new NotFoundError('Loan application', id);
      const status = transition('application', application.status, 'assess');

      const customer = await this.repo.customerById(tx, application.customer_id);
      if (!customer) throw new NotFoundError('Customer', application.customer_id);
      const { product, version } = await this.repo.versionWithProduct(
        tx,
        application.product_version_id,
      );
      const institution = await this.repo.institution(tx);
      const today = businessDate(institution.timezone, this.clock.now());

      const terms = termsSnapshot(product, version, application.term);
      const offer = priceOffer(terms, application.requested_principal, today);
      const bureau = await this.bureau.fetchReport({ nationalIdHmac: customer.national_id_hmac });
      const input: CreditAssessmentInput = {
        applicationDate: today,
        principal: offer.origination.financedPrincipal,
        term: application.term,
        kycStatus: customer.kyc_status,
        ownerDateOfBirth: customer.date_of_birth,
        tenureMonths: customer.months_in_employment,
        monthlyIncome: customer.monthly_income,
        existingMonthlyDebt: customer.existing_monthly_debt,
        existingTenantMaxDpd: await this.repo.maxActiveDpd(tx, customer.id),
        bureau: { score: bureau.score, delinquent: bureau.delinquent },
        product: {
          currency: assertCurrency(version.currency),
          annualRateBps: version.annual_interest_rate_bps,
          frequency: version.repayment_frequency,
          method: version.interest_method,
          minPrincipal: version.min_principal,
          maxDtiBps: version.max_dti_bps,
          minCreditScore: version.min_credit_score,
        },
      };
      const result = assessCredit(input);

      const row = await this.repo.insertAssessment(tx, {
        tenant_id: principal.tenantId,
        application_id: application.id,
        model_version: result.modelVersion,
        bureau_score: bureau.score,
        bureau_delinquent: bureau.delinquent,
        dti_bps: result.dtiBps,
        instalment_amount: result.instalmentAmount,
        scorecard_points: result.points,
        grade: result.grade,
        decision: result.decision,
        reason_codes: result.reasonCodes,
        max_affordable_principal: result.maxAffordablePrincipal,
        apr_bps: offer.aprBps,
        inputs: snapshotOf({
          scorecard: input,
          bureauProvider: bureau.provider,
          pointsBreakdown: result.pointsBreakdown,
          monthlyInstalment: result.monthlyInstalment,
          ownerAge: result.ownerAge,
          // Not a scorecard-v1 factor; recorded for the underwriter's file.
          monthlyExpenses: customer.monthly_expenses,
          terms,
          disclosure: offer.disclosure,
        }),
        assessed_by: principal.id,
      });
      await this.repo.update(tx, application.id, { status });
      const view = toAssessmentView(row, offer.disclosure);

      await this.audit.record(tx, {
        action: 'loan_application.assessed',
        entityType: 'loan_application',
        entityId: application.id,
        before: { status: application.status },
        after: {
          status,
          assessmentId: row.id,
          decision: row.decision,
          grade: row.grade,
          reasonCodes: row.reason_codes,
          aprBps: row.apr_bps,
        },
      });
      await this.outbox.publish(tx, {
        type: 'loan_application.assessed',
        aggregateType: 'loan_application',
        aggregateId: application.id,
        data: {
          applicationId: application.id,
          assessmentId: row.id,
          decision: row.decision,
          grade: row.grade,
          reasonCodes: row.reason_codes,
        },
      });
      return view;
    });
  }
}
