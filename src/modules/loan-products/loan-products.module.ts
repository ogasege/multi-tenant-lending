import { Module } from '@nestjs/common';

import { CreateLoanProduct } from './application/create-loan-product.use-case';
import { CreateProductVersion } from './application/create-product-version.use-case';
import { GetLoanProduct } from './application/get-loan-product.use-case';
import { GetProductVersion } from './application/get-product-version.use-case';
import { ListLoanProducts } from './application/list-loan-products.use-case';
import { QuoteLoanProduct } from './application/quote-loan-product.use-case';
import { UpdateProductStatus } from './application/update-product-status.use-case';
import { LoanProductsRepository } from './infrastructure/loan-products.repository';
import { LoanProductsController } from './interface/http/loan-products.controller';

/** Versioned white-label loan products and quotes (SPEC §7.1, §7.4, §10). */
@Module({
  controllers: [LoanProductsController],
  providers: [
    LoanProductsRepository,
    CreateLoanProduct,
    ListLoanProducts,
    GetLoanProduct,
    GetProductVersion,
    CreateProductVersion,
    UpdateProductStatus,
    QuoteLoanProduct,
  ],
})
export class LoanProductsModule {}
