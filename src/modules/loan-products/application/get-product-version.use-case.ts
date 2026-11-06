import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { LoanProductsRepository } from '../infrastructure/loan-products.repository';

import {
  forTermsAudience,
  type ProductAudience,
  type ProductTermsView,
  toTermsView,
} from './loan-product.view';

/**
 * The full, immutable terms of one specific version of a product. Borrowers get the
 * borrower view, and 404 unless the product is ACTIVE.
 */
@Injectable()
export class GetProductVersion {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
  ) {}

  execute(
    productId: string,
    version: number,
    audience: ProductAudience = 'staff',
  ): Promise<ProductTermsView> {
    return this.runner.run(async (tx) => {
      if (audience === 'borrower') {
        const product = await this.repo.findProduct(tx, productId);
        if (product?.status !== 'ACTIVE') throw new NotFoundError('Loan product version');
      }
      const row = await this.repo.findVersion(tx, productId, version);
      if (!row) throw new NotFoundError('Loan product version');
      return forTermsAudience(toTermsView(row), audience);
    });
  }
}
