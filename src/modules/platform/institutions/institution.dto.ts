import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsTimeZone,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { StrongPassword } from '../../../common/auth/password-policy';
import type { LenderType, Row, UserRole } from '../../../common/database/schema';
import { NormalisedEmail } from '../../../common/http/normalised-email';
import { PageDto } from '../../../common/http/pagination';
import { HEX_COLOR, LOCALE } from '../../institutions/domain/branding-rules';

export const LENDER_TYPES: readonly LenderType[] = [
  'COMMERCIAL_BANK',
  'MICROFINANCE_BANK',
  'FINANCE_COMPANY',
  'MONEY_LENDER',
  'MICROFINANCE_INSTITUTION',
];
export const INSTITUTION_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

const CURRENCY = /^[A-Z]{3}$/;

export class BrandingInputDto {
  @ApiProperty({ example: 'Lagos Health Credit' })
  @IsString()
  @Length(2, 100)
  displayName!: string;

  @ApiPropertyOptional({ example: '#0B5FFF' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'primaryColor must be a #RRGGBB hex colour' })
  primaryColor?: string;

  @ApiPropertyOptional({ example: '#111827' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'secondaryColor must be a #RRGGBB hex colour' })
  secondaryColor?: string;

  @ApiPropertyOptional({ example: 'en-NG' })
  @IsOptional()
  @Matches(LOCALE, { message: 'locale must be a BCP 47 tag such as en-NG or fr-SN' })
  locale?: string;
}

export class FirstAdminDto {
  @ApiProperty({ example: 'Ada Obi' })
  @IsString()
  @Length(2, 200)
  fullName!: string;

  @NormalisedEmail()
  email!: string;

  @StrongPassword()
  password!: string;
}

export class RegisterInstitutionDto {
  @ApiProperty({ example: 'lagos-health-credit', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lower-case kebab-case' })
  @Length(3, 63)
  slug!: string;

  @ApiProperty({ example: 'Lagos Health Credit MFB Ltd' })
  @IsString()
  @Length(2, 200)
  legalName!: string;

  @ApiProperty({ example: 'NG', description: 'ISO 3166-1 alpha-2' })
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be ISO 3166-1 alpha-2' })
  countryCode!: string;

  @ApiProperty({ example: 'NGN' })
  @Matches(CURRENCY, { message: 'defaultCurrency must be an ISO 4217 code' })
  defaultCurrency!: string;

  @ApiProperty({ example: ['NGN'], type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(CURRENCY, { each: true, message: 'supportedCurrencies must be ISO 4217 codes' })
  supportedCurrencies!: string[];

  @ApiProperty({ enum: LENDER_TYPES })
  @IsIn(LENDER_TYPES)
  lenderType!: LenderType;

  @ApiPropertyOptional({ description: 'Usury cap on the all-in APR, basis points', example: 2400 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxAprBps?: number;

  @ApiProperty({
    example: 'af-south-1',
    description: 'AWS region that holds this tenant’s data (cell-based residency, SPEC §4.1)',
  })
  @Matches(/^[a-z]{2}-[a-z]+-\d$/, { message: 'homeRegion must be an AWS region code' })
  homeRegion!: string;

  @ApiPropertyOptional({ example: 'Africa/Lagos', default: 'Africa/Lagos' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiProperty({ type: BrandingInputDto })
  @ValidateNested()
  @Type(() => BrandingInputDto)
  branding!: BrandingInputDto;

  @ApiProperty({ type: FirstAdminDto })
  @ValidateNested()
  @Type(() => FirstAdminDto)
  firstAdmin!: FirstAdminDto;
}

export class ChangeInstitutionStatusDto {
  @ApiProperty({ enum: INSTITUTION_STATUSES })
  @IsIn(INSTITUTION_STATUSES)
  status!: InstitutionStatus;

  @ApiProperty({ example: 'Licence under regulatory review' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class InstitutionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty() countryCode!: string;
  @ApiProperty() defaultCurrency!: string;
  @ApiProperty({ type: [String] }) supportedCurrencies!: string[];
  @ApiProperty({ enum: LENDER_TYPES }) lenderType!: LenderType;
  @ApiProperty({ type: Number, nullable: true }) maxAprBps!: number | null;
  @ApiProperty() timezone!: string;
  @ApiProperty({ example: 'af-south-1' }) homeRegion!: string;
  @ApiProperty({ enum: INSTITUTION_STATUSES }) status!: InstitutionStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(row: Row<'institutions'>): InstitutionDto {
    return {
      id: row.id,
      slug: row.slug,
      legalName: row.legal_name,
      countryCode: row.country_code,
      defaultCurrency: row.default_currency,
      supportedCurrencies: row.supported_currencies,
      lenderType: row.lender_type,
      maxAprBps: row.max_apr_bps,
      timezone: row.timezone,
      homeRegion: row.home_region,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

export class InstitutionBrandingDto {
  @ApiProperty() displayName!: string;
  @ApiProperty() primaryColor!: string;
  @ApiProperty() secondaryColor!: string;
  @ApiProperty() locale!: string;
}

export class InstitutionAdminDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ['INSTITUTION_ADMIN'] }) role!: UserRole;
}

export class RegisteredInstitutionDto extends InstitutionDto {
  @ApiProperty({ type: InstitutionBrandingDto }) branding!: InstitutionBrandingDto;
  @ApiProperty({ type: InstitutionAdminDto }) firstAdmin!: InstitutionAdminDto;
  @ApiProperty({ example: 9, description: 'Ledger accounts created (chart × currencies)' })
  ledgerAccountsCreated!: number;
}

export class InstitutionPageDto extends PageDto(InstitutionDto) {}
