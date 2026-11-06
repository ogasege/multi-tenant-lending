import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../../common/errors/app-error';
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
  toTermsView,
} from './loan-product.view';

export interface CreateProductVersionCommand {
  productId: string;
  expectedVersion: number;
  terms: ProductTermsCommand;
}

/**
 * Publishes new terms as the next immutable version of a product.
 *
 * Versions are never edited: `loan_product_versions` has no UPDATE/DELETE grant and an
 * immutability trigger. Applications reference the exact version they were made against,
 * and approval copies that version's terms into `loans.terms` (a JSONB snapshot), so
 * existing applications and loans keep the terms the borrower agreed to; only new
 * applications pick up the new version.
 *
 * Concurrency: the product row is locked and `current_version` must equal
 * `expectedVersion`, otherwise 409 CONCURRENT_MODIFICATION. Archived products cannot get
 * new versions (422 PRODUCT_NOT_ACTIVE).
 */
@Injectable()
export class CreateProductVersion {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  execute(actor: TenantUser, cmd: CreateProductVersionCommand): Promise<LoanProductView> {
    return this.runner.run(async (tx) => {
      const product = await this.repo.findProduct(tx, cmd.productId, { forUpdate: true });
      if (!product) throw new NotFoundError('Loan product', cmd.productId);
      if (product.status !== 'ACTIVE') {
        throw new BusinessRuleError(
          ErrorCode.PRODUCT_NOT_ACTIVE,
          'Archived products cannot receive new versions',
        );
      }
      if (product.current_version !== cmd.expectedVersion) {
        throw new ConflictError(
          ErrorCode.CONCURRENT_MODIFICATION,
          'The product has a newer version; reload and retry',
          { currentVersion: product.current_version },
        );
      }
      const policy = await this.repo.institutionPolicy(tx);
      if (!policy) throw new NotFoundError('Institution');
      const terms = validateProductTerms(toTermsInput(cmd.terms), policy);
      assertProductAprWithinCap(terms, policy.maxAprBps);

      const previous = await this.repo.findVersion(tx, product.id, product.current_version);
      const nextVersion = product.current_version + 1;
      const version = await this.repo.insertVersion(tx, {
        tenantId: actor.tenantId,
        productId: product.id,
        version: nextVersion,
        terms,
        createdBy: actor.id,
      });
      const updated = await this.repo.setCurrentVersion(
        tx,
        product.id,
        cmd.expectedVersion,
        nextVersion,
      );
      // Unreachable while the row lock is held; guards the compare-and-set contract.
      if (!updated) throw new ConflictError(ErrorCode.CONCURRENT_MODIFICATION, 'Product changed');

      await this.audit.record(tx, {
        action: 'loan_product.version_created',
        entityType: 'loan_product',
        entityId: product.id,
        before: previous && toTermsView(previous),
        after: toTermsView(version),
      });
      await this.outbox.publish(tx, {
        type: 'loan_product.version_created',
        aggregateType: 'loan_product',
        aggregateId: product.id,
        data: { productId: product.id, version: nextVersion, versionId: version.id },
      });
      return toProductView(updated, version);
    });
  }
}
