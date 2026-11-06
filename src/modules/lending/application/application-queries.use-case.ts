import { Injectable } from '@nestjs/common';

import type { TenantUser } from '../../../common/auth/decorators';
import type { ApplicationStatus } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import {
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  toPage,
} from '../../../common/http/pagination';
import { ApplicationsRepository } from '../infrastructure/applications.repository';

import { ownCustomerScope } from './customer-scope';
import { type ApplicationView, audienceOf, toApplicationView } from './lending.views';

export interface ApplicationDetailView extends ApplicationView {
  /** Latest credit assessment summary, if the application has been assessed. */
  latestAssessment: {
    id: string;
    decision: string;
    /** Internal risk grade; `null` for CUSTOMER callers. */
    grade: string | null;
    reasonCodes: string[];
    aprBps: number | null;
    maxAffordablePrincipal: string | null;
    createdAt: string;
  } | null;
}

/**
 * Applications list, newest first (keyset). Staff see the tenant's applications and may
 * filter by status/customer; a CUSTOMER sees only their own.
 */
@Injectable()
export class ListApplications {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: ApplicationsRepository,
  ) {}

  execute(
    principal: TenantUser,
    query: { limit?: number; cursor?: string; status?: ApplicationStatus; customerId?: string },
  ): Promise<Page<ApplicationView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    return this.runner.run(async (tx) => {
      const own = await ownCustomerScope(tx, principal);
      const rows = await this.repo.list(tx, {
        limit,
        after: decodeCursor(query.cursor),
        status: query.status,
        customerId: own ?? query.customerId,
      });
      return toPage(rows, limit, (row) => toApplicationView(row, null, audienceOf(principal)));
    });
  }
}

/** One application with its latest assessment; another customer's is a 404. */
@Injectable()
export class GetApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: ApplicationsRepository,
  ) {}

  execute(principal: TenantUser, id: string): Promise<ApplicationDetailView> {
    return this.runner.run(async (tx) => {
      const own = await ownCustomerScope(tx, principal);
      const row = await this.repo.find(tx, id, { customerId: own });
      if (!row) throw new NotFoundError('Loan application', id);
      const assessment = await this.repo.latestAssessment(tx, row.id);
      return {
        ...toApplicationView(row, await this.repo.loanIdOf(tx, row.id), audienceOf(principal)),
        latestAssessment: assessment
          ? {
              id: assessment.id,
              decision: assessment.decision,
              // The internal risk grade is not part of the borrower's view.
              grade: own === undefined ? assessment.grade : null,
              reasonCodes: assessment.reason_codes,
              aprBps: assessment.apr_bps,
              maxAffordablePrincipal: assessment.max_affordable_principal?.toString() ?? null,
              createdAt: assessment.created_at.toISOString(),
            }
          : null,
      };
    });
  }
}
