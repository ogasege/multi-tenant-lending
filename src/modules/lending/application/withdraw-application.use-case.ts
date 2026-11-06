import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { ForbiddenError, NotFoundError } from '../../../common/errors/app-error';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { transition } from '../domain';
import { ApplicationsRepository } from '../infrastructure/applications.repository';

import { ownCustomerScope } from './customer-scope';
import { type ApplicationView, toApplicationView } from './lending.views';

/**
 * The applicant customer withdraws their own application while it is SUBMITTED or ASSESSED
 * (SPEC §7.2). Staff cannot withdraw on a customer's behalf (403; they reject instead);
 * another customer's application is a 404. Illegal states ⇒ 409 INVALID_STATE_TRANSITION.
 */
@Injectable()
export class WithdrawApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: ApplicationsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  execute(principal: TenantUser, id: string): Promise<ApplicationView> {
    if (principal.role !== 'CUSTOMER') {
      return Promise.reject(
        new ForbiddenError(undefined, 'Only the applicant can withdraw an application'),
      );
    }
    return this.runner.run(async (tx) => {
      const own = await ownCustomerScope(tx, principal);
      const before = await this.repo.find(tx, id, { customerId: own, forUpdate: true });
      if (!before) throw new NotFoundError('Loan application', id);
      const status = transition('application', before.status, 'withdraw');
      const row = await this.repo.update(tx, id, { status });
      const view = toApplicationView(row, null, 'CUSTOMER');

      await this.audit.record(tx, {
        action: 'loan_application.withdrawn',
        entityType: 'loan_application',
        entityId: id,
        before: { status: before.status },
        after: { status },
      });
      await this.outbox.publish(tx, {
        type: 'loan_application.withdrawn',
        aggregateType: 'loan_application',
        aggregateId: id,
        data: { applicationId: id, reference: row.reference, customerId: row.customer_id },
      });
      return view;
    });
  }
}
