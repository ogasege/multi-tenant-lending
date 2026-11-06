import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import {
  LoanProductsRepository,
  type ProductStatus,
} from '../infrastructure/loan-products.repository';

import { type LoanProductView, toProductView } from './loan-product.view';

/**
 * Activates or archives a product. Archiving stops new applications and new versions but
 * leaves existing applications and loans untouched (they hold their own version/snapshot).
 * Setting the status a product already has is an idempotent no-op (no audit, no event).
 */
@Injectable()
export class UpdateProductStatus {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  execute(productId: string, status: ProductStatus): Promise<LoanProductView> {
    return this.runner.run(async (tx) => {
      const before = await this.repo.findProduct(tx, productId, { forUpdate: true });
      if (!before) throw new NotFoundError('Loan product', productId);
      const current = await this.repo.findVersion(tx, before.id, before.current_version);
      if (!current) throw new NotFoundError('Loan product version');
      if (before.status === status) return toProductView(before, current);

      const after = await this.repo.setStatus(tx, before.id, status);
      await this.audit.record(tx, {
        action: 'loan_product.status_changed',
        entityType: 'loan_product',
        entityId: before.id,
        before: { status: before.status },
        after: { status: after.status },
      });
      await this.outbox.publish(tx, {
        type: 'loan_product.status_changed',
        aggregateType: 'loan_product',
        aggregateId: before.id,
        data: { productId: before.id, from: before.status, to: after.status },
      });
      return toProductView(after, current);
    });
  }
}
