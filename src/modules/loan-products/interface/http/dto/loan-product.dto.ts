import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PageDto, PageQueryDto } from '../../../../../common/http/pagination';

import { POSITIVE_INT_STRING, ProductTermsDto, ProductTermsViewDto } from './product-terms.dto';

const STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
type Status = (typeof STATUSES)[number];

export class CreateLoanProductDto {
  @ApiProperty({ example: 'PHARMA_30', pattern: '^[A-Z0-9_-]{2,32}$' })
  @Matches(/^[A-Z0-9_-]{2,32}$/, { message: 'code must be 2–32 of A-Z, 0-9, _ or -' })
  code!: string;

  @ApiProperty({ example: 'Pharmacy restock 30 days' })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ type: ProductTermsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ProductTermsDto)
  terms!: ProductTermsDto;
}

export class CreateProductVersionDto {
  @ApiProperty({ description: 'The product’s current version as read (optimistic check)' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ type: ProductTermsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ProductTermsDto)
  terms!: ProductTermsDto;
}

export class UpdateProductStatusDto {
  @ApiProperty({ enum: STATUSES })
  @IsIn(STATUSES)
  status!: Status;
}

export class ListLoanProductsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: Status;
}

export class QuoteRequestDto {
  @ApiProperty({ example: '10000000', description: 'Requested principal, minor units' })
  @Matches(POSITIVE_INT_STRING, { message: 'principal must be a positive integer string' })
  principal!: string;

  @ApiProperty({ example: 12, description: 'Instalments, or days for BULLET' })
  @IsInt()
  @Min(1)
  term!: number;

  @ApiPropertyOptional({
    example: '2026-11-06',
    description: 'Defaults to today in the institution’s time zone',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'disbursementDate must be YYYY-MM-DD' })
  disbursementDate?: string;
}

export class LoanProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: Status;
  @ApiProperty() currentVersion!: number;
  @ApiProperty({ type: ProductTermsViewDto }) terms!: ProductTermsViewDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ProductVersionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Staff only (omitted for customers)',
  })
  createdBy?: string | null;
}

export class LoanProductDetailDto extends LoanProductDto {
  @ApiProperty({ type: [ProductVersionSummaryDto], description: 'Newest first' })
  versions!: ProductVersionSummaryDto[];
}

export class LoanProductPageDto extends PageDto(LoanProductDto) {}

export class QuoteInstalmentDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ example: '2026-12-06' }) dueDate!: string;
  @ApiProperty({ example: '788929' }) principal!: string;
  @ApiProperty({ example: '200000' }) interest!: string;
  @ApiProperty({ example: '988929' }) total!: string;
}

export class QuoteDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productVersion!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() principal!: string;
  @ApiProperty() term!: number;
  @ApiProperty({ enum: ['DAYS', 'INSTALMENTS'] }) termUnit!: string;
  @ApiProperty() repaymentFrequency!: string;
  @ApiProperty({ enum: ['REDUCING_BALANCE', 'FLAT', 'EQUAL_PRINCIPAL', 'SIMPLE'] })
  interestMethod!: string;

  @ApiProperty() annualInterestRateBps!: number;
  @ApiProperty() disbursementDate!: string;
  @ApiProperty() maturityDate!: string;
  @ApiProperty() originationFee!: string;
  @ApiProperty({ enum: ['DEDUCTED', 'CAPITALISED'] }) originationFeeTreatment!: string;
  @ApiProperty({ description: 'Principal the schedule amortises' }) financedPrincipal!: string;
  @ApiProperty({ description: 'Cash paid out at disbursement' }) netDisbursed!: string;
  @ApiProperty() totalInterest!: string;
  @ApiProperty() totalRepayable!: string;
  @ApiProperty({ description: 'totalRepayable − netDisbursed' }) totalCostOfCredit!: string;
  @ApiProperty({ description: 'All-in APR (annualised IRR), bps' }) aprBps!: number;
  @ApiProperty({ type: Number, nullable: true }) maxAprBps!: number | null;
  @ApiProperty() aprWithinCap!: boolean;
  @ApiProperty({ type: [QuoteInstalmentDto] }) instalments!: QuoteInstalmentDto[];
}
