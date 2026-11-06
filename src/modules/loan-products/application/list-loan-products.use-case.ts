import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  type PageQueryDto,
  toPage,
} from '../../../common/http/pagination';
import {
  LoanProductsRepository,
  type ProductStatus,
} from '../infrastructure/loan-products.repository';

import {
  forProductAudience,
  type LoanProductView,
  type ProductAudience,
  toProductView,
} from './loan-product.view';

/**
 * Cursor-paginated product list with each product's current terms. Borrowers only ever see
 * ACTIVE products (whatever status they ask for), in the borrower view.
 */
@Injectable()
export class ListLoanProducts {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: LoanProductsRepository,
  ) {}

  execute(
    query: PageQueryDto & { status?: ProductStatus },
    audience: ProductAudience = 'staff',
  ): Promise<Page<LoanProductView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const status = audience === 'borrower' ? 'ACTIVE' : query.status;
    return this.runner.run(async (tx) => {
      const rows = await this.repo.listProducts(tx, {
        limit,
        after: decodeCursor(query.cursor),
        status,
      });
      return toPage(
        rows.map((r) => ({
          ...r,
          id: r.product.id,
          created_at: r.product.created_at,
          cursor_ts: r.cursorTs,
        })),
        limit,
        (r) => forProductAudience(toProductView(r.product, r.current), audience),
      );
    });
  }
}
