import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import type { Page } from '../../../../common/http/pagination';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import { CreateLoanProduct } from '../../application/create-loan-product.use-case';
import { CreateProductVersion } from '../../application/create-product-version.use-case';
import { GetLoanProduct } from '../../application/get-loan-product.use-case';
import { GetProductVersion } from '../../application/get-product-version.use-case';
import { ListLoanProducts } from '../../application/list-loan-products.use-case';
import {
  audienceOf,
  type LoanProductDetailView,
  type LoanProductView,
  type ProductTermsView,
} from '../../application/loan-product.view';
import { QuoteLoanProduct, type QuoteView } from '../../application/quote-loan-product.use-case';
import { UpdateProductStatus } from '../../application/update-product-status.use-case';

import {
  CreateLoanProductDto,
  CreateProductVersionDto,
  ListLoanProductsQueryDto,
  LoanProductDetailDto,
  LoanProductDto,
  LoanProductPageDto,
  QuoteDto,
  QuoteRequestDto,
  UpdateProductStatusDto,
} from './dto/loan-product.dto';
import { ProductTermsViewDto } from './dto/product-terms.dto';

/** Versioned, tenant-configured loan products (SPEC §7.1). */
@ApiTags('Loan products')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('loan-products')
export class LoanProductsController {
  constructor(
    private readonly createProduct: CreateLoanProduct,
    private readonly listProducts: ListLoanProducts,
    private readonly getProduct: GetLoanProduct,
    private readonly getVersion: GetProductVersion,
    private readonly createVersion: CreateProductVersion,
    private readonly updateStatus: UpdateProductStatus,
    private readonly quoteProduct: QuoteLoanProduct,
  ) {}

  @Post()
  @RequirePermissions(Permission.PRODUCT_WRITE)
  @ApiOperation({
    summary: 'Create a loan product (version 1)',
    description: 'The nominal rate may not exceed the institution APR cap (422 APR_EXCEEDS_CAP).',
  })
  @ApiCreatedResponse({ type: LoanProductDto })
  @ApiProblemResponses(400, 409, 422)
  create(
    @CurrentTenantUser() actor: TenantUser,
    @Body() dto: CreateLoanProductDto,
  ): Promise<LoanProductView> {
    return this.createProduct.execute(actor, dto);
  }

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  @ApiOperation({
    summary: 'List loan products (cursor pagination, newest first)',
    description: 'Customers see ACTIVE products only, without underwriting thresholds.',
  })
  @ApiOkResponse({ type: LoanProductPageDto })
  @ApiProblemResponses(400)
  list(
    @CurrentTenantUser() viewer: TenantUser,
    @Query() query: ListLoanProductsQueryDto,
  ): Promise<Page<LoanProductView>> {
    return this.listProducts.execute(query, audienceOf(viewer.role));
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCT_READ)
  @ApiOperation({ summary: 'Get a loan product with current terms and version history' })
  @ApiOkResponse({ type: LoanProductDetailDto })
  @ApiProblemResponses(400, 404)
  get(
    @CurrentTenantUser() viewer: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LoanProductDetailView> {
    return this.getProduct.execute(id, audienceOf(viewer.role));
  }

  @Get(':id/versions/:version')
  @RequirePermissions(Permission.PRODUCT_READ)
  @ApiOperation({ summary: 'Get the immutable terms of one product version' })
  @ApiOkResponse({ type: ProductTermsViewDto })
  @ApiProblemResponses(400, 404)
  version(
    @CurrentTenantUser() viewer: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<ProductTermsView> {
    return this.getVersion.execute(id, version, audienceOf(viewer.role));
  }

  @Post(':id/versions')
  @RequirePermissions(Permission.PRODUCT_WRITE)
  @ApiOperation({
    summary: 'Publish new terms as the next immutable version',
    description:
      'Existing applications and loans keep the version/snapshot they were made with. ' +
      '`expectedVersion` must equal the current version (409 CONCURRENT_MODIFICATION).',
  })
  @ApiCreatedResponse({ type: LoanProductDto })
  @ApiProblemResponses(400, 404, 409, 422)
  addVersion(
    @CurrentTenantUser() actor: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProductVersionDto,
  ): Promise<LoanProductView> {
    return this.createVersion.execute(actor, {
      productId: id,
      expectedVersion: dto.expectedVersion,
      terms: dto.terms,
    });
  }

  @Patch(':id/status')
  @RequirePermissions(Permission.PRODUCT_WRITE)
  @ApiOperation({ summary: 'Activate or archive a loan product' })
  @ApiOkResponse({ type: LoanProductDto })
  @ApiProblemResponses(400, 404)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductStatusDto,
  ): Promise<LoanProductView> {
    return this.updateStatus.execute(id, dto.status);
  }

  @Post(':id/quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_READ)
  @ApiOperation({
    summary: 'Preview schedule, fees, APR and total cost of credit (no persistence)',
  })
  @ApiOkResponse({ type: QuoteDto })
  @ApiProblemResponses(400, 404, 422)
  quote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteRequestDto): Promise<QuoteView> {
    return this.quoteProduct.execute({
      productId: id,
      principal: dto.principal,
      term: dto.term,
      disbursementDate: dto.disbursementDate,
    });
  }
}
