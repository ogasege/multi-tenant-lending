import { ApiProperty } from '@nestjs/swagger';

import type { LenderType } from '../../../../../common/database/schema';

const LENDER_TYPES: LenderType[] = [
  'COMMERCIAL_BANK',
  'MICROFINANCE_BANK',
  'FINANCE_COMPANY',
  'MONEY_LENDER',
  'MICROFINANCE_INSTITUTION',
];

/** The caller's institution as registered by the platform. Read-only for tenants. */
export class InstitutionProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'acme-mfb' }) slug!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ example: 'NG', description: 'ISO 3166-1 alpha-2' }) countryCode!: string;
  @ApiProperty({ example: 'NGN' }) defaultCurrency!: string;
  @ApiProperty({ type: [String], example: ['NGN'] }) supportedCurrencies!: string[];
  @ApiProperty({ example: 'Africa/Lagos' }) timezone!: string;
  @ApiProperty({ enum: LENDER_TYPES }) lenderType!: LenderType;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Regulatory APR ceiling in basis points; null = none',
  })
  maxAprBps!: number | null;

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: 'ACTIVE' | 'SUSPENDED';
}
