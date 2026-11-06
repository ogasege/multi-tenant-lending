import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { LoanProductsRepository } from '../infrastructure/loan-products.repository';

import {
  forDetailAudience,
  type LoanProductDetailView,
  type ProductAudience,
  toProductView,
} from './loan-product.view';

/**
 * One product with its current terms and the list of all its versions (newest first).
 * Borrowers get the borrower view, and 404 for products that are not ACTIVE.
 */
@Injectable()
export class GetLoanProduct {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
  ) {}

  execute(productId: string, audience: ProductAudience = 'staff'): Promise<LoanProductDetailView> {
    return this.runner.run(async (tx) => {
      const product = await this.repo.findProduct(tx, productId);
      if (!product || (audience === 'borrower' && product.status !== 'ACTIVE')) {
        throw new NotFoundError('Loan product', productId);
      }
      const current = await this.repo.findVersion(tx, product.id, product.current_version);
      if (!current) throw new NotFoundError('Loan product version');
      const versions = await this.repo.listVersions(tx, product.id);
      return forDetailAudience(
        {
          ...toProductView(product, current),
          versions: versions.map((v) => ({
            id: v.id,
            version: v.version,
            createdAt: v.created_at,
            createdBy: v.created_by,
          })),
        },
        audience,
      );
    });
  }
}
