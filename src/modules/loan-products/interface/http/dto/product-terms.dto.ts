import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type {
  FeeTreatment,
  FeeType,
  InterestMethod,
  PayeeType,
  RepaymentFrequency,
} from '../../../../../common/database/schema';

/** Non-negative integer string (minor units or bps); strings avoid 2^53 precision loss. */
export const UINT_STRING = /^(0|[1-9]\d{0,17})$/;
/** Positive integer string (minor units). */
export const POSITIVE_INT_STRING = /^[1-9]\d{0,17}$/;

const FREQUENCIES: RepaymentFrequency[] = ['BULLET', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'];
const METHODS: InterestMethod[] = ['REDUCING_BALANCE', 'FLAT', 'EQUAL_PRINCIPAL'];
const FEE_TYPES: FeeType[] = ['NONE', 'FLAT', 'PERCENTAGE'];
const TREATMENTS: FeeTreatment[] = ['DEDUCTED', 'CAPITALISED'];
const MODES: PayeeType[] = ['VENDOR', 'BORROWER'];

export class OriginationFeeDto {
  @ApiProperty({ enum: FEE_TYPES })
  @IsIn(FEE_TYPES)
  type!: FeeType;

  @ApiProperty({ example: '200', description: 'FLAT: minor units; PERCENTAGE: bps; NONE: 0' })
  @Matches(UINT_STRING, { message: 'value must be a non-negative integer string' })
  value!: string;

  @ApiProperty({ enum: TREATMENTS })
  @IsIn(TREATMENTS)
  treatment!: FeeTreatment;
}

export class LateFeeDto {
  @ApiProperty({ enum: FEE_TYPES })
  @IsIn(FEE_TYPES)
  type!: FeeType;

  @ApiProperty({ example: '500000', description: 'FLAT: minor units; PERCENTAGE: bps' })
  @Matches(UINT_STRING, { message: 'value must be a non-negative integer string' })
  value!: string;

  @ApiProperty({ example: 3, minimum: 0, maximum: 90 })
  @IsInt()
  @Min(0)
  @Max(90)
  graceDays!: number;
}

/** Full economic terms of a product version (SPEC §7.1). */
export class ProductTermsDto {
  @ApiProperty({ example: 'NGN', description: 'Must be offered by the institution' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({ example: '5000000', description: 'Minor units' })
  @Matches(POSITIVE_INT_STRING, { message: 'minPrincipal must be a positive integer string' })
  minPrincipal!: string;

  @ApiProperty({ example: '500000000', description: 'Minor units' })
  @Matches(POSITIVE_INT_STRING, { message: 'maxPrincipal must be a positive integer string' })
  maxPrincipal!: string;

  @ApiProperty({ example: 3, description: 'Instalments, or days for BULLET (7–365)' })
  @IsInt()
  @Min(1)
  minTerm!: number;

  @ApiProperty({ example: 12, description: 'Instalments, or days for BULLET (7–365)' })
  @IsInt()
  @Min(1)
  maxTerm!: number;

  @ApiProperty({ enum: FREQUENCIES })
  @IsIn(FREQUENCIES)
  repaymentFrequency!: RepaymentFrequency;

  @ApiProperty({ enum: METHODS, description: 'Ignored for BULLET (simple interest)' })
  @IsIn(METHODS)
  interestMethod!: InterestMethod;

  @ApiProperty({ example: 2400, description: 'Nominal annual rate in bps (2400 = 24 %)' })
  @IsInt()
  @Min(0)
  @Max(100_000)
  annualInterestRateBps!: number;

  @ApiProperty({ type: OriginationFeeDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => OriginationFeeDto)
  originationFee!: OriginationFeeDto;

  @ApiProperty({ type: LateFeeDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LateFeeDto)
  lateFee!: LateFeeDto;

  @ApiPropertyOptional({ example: 4000, default: 4000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxDtiBps?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(850)
  minCreditScore?: number;

  @ApiPropertyOptional({ example: 14, default: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  applicationExpiryDays?: number;

  @ApiPropertyOptional({ enum: MODES, default: 'VENDOR' })
  @IsOptional()
  @IsIn(MODES)
  disbursementMode?: PayeeType;
}

export class OriginationFeeViewDto {
  @ApiProperty({ enum: FEE_TYPES }) type!: FeeType;
  @ApiProperty({ example: '200' }) value!: string;
  @ApiProperty({ enum: TREATMENTS }) treatment!: FeeTreatment;
}

export class LateFeeViewDto {
  @ApiProperty({ enum: FEE_TYPES }) type!: FeeType;
  @ApiProperty({ example: '500000' }) value!: string;
  @ApiProperty() graceDays!: number;
}

export class ProductTermsViewDto {
  @ApiProperty({ format: 'uuid' }) versionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ example: '5000000' }) minPrincipal!: string;
  @ApiProperty({ example: '500000000' }) maxPrincipal!: string;
  @ApiProperty() minTerm!: number;
  @ApiProperty() maxTerm!: number;
  @ApiProperty({ enum: FREQUENCIES }) repaymentFrequency!: RepaymentFrequency;
  @ApiProperty({ enum: METHODS }) interestMethod!: InterestMethod;
  @ApiProperty() annualInterestRateBps!: number;
  @ApiProperty({ enum: ['ACT_365F'] }) dayCount!: 'ACT_365F';
  @ApiProperty({ type: OriginationFeeViewDto }) originationFee!: OriginationFeeViewDto;
  @ApiProperty({ type: LateFeeViewDto }) lateFee!: LateFeeViewDto;
  @ApiPropertyOptional({ description: 'Staff only (omitted for customers)' })
  maxDtiBps?: number;
  @ApiPropertyOptional({ description: 'Staff only (omitted for customers)' })
  minCreditScore?: number;
  @ApiProperty() applicationExpiryDays!: number;
  @ApiProperty({ enum: MODES }) disbursementMode!: PayeeType;
  @ApiProperty() createdAt!: Date;
}
