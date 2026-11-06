import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { ConflictError, NotFoundError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { validateProductTerms } from '../domain/product-terms';
import { assertProductAprWithinCap } from '../domain/quote';
import { LoanProductsRepository } from '../infrastructure/loan-products.repository';

import {
  type LoanProductView,
  type ProductTermsCommand,
  toProductView,
  toTermsInput,
} from './loan-product.view';

export interface CreateLoanProductCommand {
  code: string;
  name: string;
  description?: string;
  terms: ProductTermsCommand;
}

/**
 * Creates a loan product and its version 1 in one transaction, together with the audit
 * record and the `loan_product.created` outbox event. Terms are validated against the
 * institution (offered currencies, APR cap) inside the same transaction.
 */
@Injectable()
export class CreateLoanProduct {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async execute(actor: TenantUser, cmd: CreateLoanProductCommand): Promise<LoanProductView> {
    try {
      return await this.runner.run(async (tx) => {
        const policy = await this.repo.institutionPolicy(tx);
        if (!policy) throw new NotFoundError('Institution');
        const terms = validateProductTerms(toTermsInput(cmd.terms), policy);
        assertProductAprWithinCap(terms, policy.maxAprBps);

        const product = await this.repo.insertProduct(tx, {
          tenantId: actor.tenantId,
          code: cmd.code,
          name: cmd.name.trim(),
          description: cmd.description?.trim() ?? null,
        });
        const version = await this.repo.insertVersion(tx, {
          tenantId: actor.tenantId,
          productId: product.id,
          version: 1,
          terms,
          createdBy: actor.id,
        });
        const view = toProductView(product, version);

        await this.audit.record(tx, {
          action: 'loan_product.created',
          entityType: 'loan_product',
          entityId: product.id,
          after: view,
        });
        await this.outbox.publish(tx, {
          type: 'loan_product.created',
          aggregateType: 'loan_product',
          aggregateId: product.id,
          data: { productId: product.id, code: product.code, version: 1 },
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          ErrorCode.DUPLICATE,
          `A loan product with code ${cmd.code} already exists`,
        );
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}
