import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { StrongPassword } from '../../common/auth/password-policy';
import { TokenPairDto } from '../../common/auth/token-pair.dto';
import type { Row } from '../../common/database/schema';
import { NormalisedEmail } from '../../common/http/normalised-email';
import { PageDto } from '../../common/http/pagination';

export const CUSTOMER_TYPES = ['BUSINESS', 'INDIVIDUAL'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const EMPLOYMENT_STATUSES = [
  'EMPLOYED',
  'SELF_EMPLOYED',
  'BUSINESS_OWNER',
  'UNEMPLOYED',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export const KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

/** Money in ISO-4217 minor units as a decimal-integer string (SPEC §6). */
const MINOR_UNITS = /^\d{1,15}$/;
const MONEY_MESSAGE = 'must be a non-negative integer string in minor units (max 15 digits)';
const isBusiness = (o: RegisterCustomerDto) => o.customerType !== 'INDIVIDUAL';

export class RegisterCustomerDto {
  @ApiPropertyOptional({ enum: CUSTOMER_TYPES, default: 'BUSINESS' })
  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  customerType?: CustomerType;

  @ApiPropertyOptional({ example: 'HealthPlus Pharmacy Ltd', description: 'Required for BUSINESS' })
  @ValidateIf(isBusiness)
  @IsString()
  @Length(2, 200)
  businessName?: string;

  @ApiPropertyOptional({ example: 'RC1234567', description: 'Required for BUSINESS (CAC RC/BN)' })
  @ValidateIf(isBusiness)
  @IsString()
  @Length(2, 50)
  businessRegistrationNumber?: string;

  @ApiPropertyOptional({ example: 'PCN/PREM/2024/0001' })
  @IsOptional()
  @IsString()
  @Length(2, 50)
  operatingLicenceNumber?: string;

  @ApiProperty({ example: 'Amaka' })
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @ApiProperty({ example: 'Eze' })
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @NormalisedEmail()
  email!: string;

  @ApiProperty({ example: '+2348012345678', description: 'E.164' })
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in E.164 format, e.g. +2348012345678' })
  phone!: string;

  @ApiProperty({ example: '1985-04-12', format: 'date' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth!: string;

  @ApiProperty({
    example: '22212345678',
    description: 'BVN or NIN (11 digits). Stored only as an HMAC plus the last 4 digits.',
    writeOnly: true,
  })
  @Matches(/^\d{11}$/, { message: 'nationalId must be 11 digits (BVN/NIN)' })
  nationalId!: string;

  @ApiProperty({ enum: EMPLOYMENT_STATUSES })
  @IsIn(EMPLOYMENT_STATUSES)
  employmentStatus!: EmploymentStatus;

  @ApiPropertyOptional({ example: 'Self' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  employerName?: string;

  @ApiProperty({ example: 36, minimum: 0, maximum: 1200 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1200)
  monthsInEmployment!: number;

  @ApiProperty({ example: 'NGN', description: 'Must be supported by the institution' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({ example: '150000000', description: 'Minor units' })
  @Matches(MINOR_UNITS, { message: `monthlyIncome ${MONEY_MESSAGE}` })
  monthlyIncome!: string;

  @ApiProperty({ example: '60000000', description: 'Minor units' })
  @Matches(MINOR_UNITS, { message: `monthlyExpenses ${MONEY_MESSAGE}` })
  monthlyExpenses!: string;

  @ApiProperty({ example: '0', description: 'Minor units' })
  @Matches(MINOR_UNITS, { message: `existingMonthlyDebt ${MONEY_MESSAGE}` })
  existingMonthlyDebt!: string;

  @StrongPassword()
  password!: string;
}

export class CustomerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-7KQ2MX' }) reference!: string;
  @ApiProperty({ enum: CUSTOMER_TYPES }) customerType!: CustomerType;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ type: String, nullable: true }) businessName!: string | null;
  @ApiProperty({ type: String, nullable: true }) businessRegistrationNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) operatingLicenceNumber!: string | null;
  @ApiProperty() email!: string;
  @ApiProperty() phone!: string;
  @ApiProperty({ format: 'date' }) dateOfBirth!: string;
  @ApiProperty({ example: '5678', description: 'Last 4 digits of the BVN/NIN' })
  nationalIdLast4!: string;
  @ApiProperty({ enum: KYC_STATUSES }) kycStatus!: (typeof KYC_STATUSES)[number];
  @ApiProperty({ enum: EMPLOYMENT_STATUSES }) employmentStatus!: EmploymentStatus;
  @ApiProperty({ type: String, nullable: true }) employerName!: string | null;
  @ApiProperty() monthsInEmployment!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ example: '150000000' }) monthlyIncome!: string;
  @ApiProperty({ example: '60000000' }) monthlyExpenses!: string;
  @ApiProperty({ example: '0' }) existingMonthlyDebt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  /** Explicit mapping: the national-id HMAC and the user link never leave the service. */
  static from(row: Row<'customers'>): CustomerDto {
    return {
      id: row.id,
      reference: row.reference,
      customerType: row.customer_type,
      firstName: row.first_name,
      lastName: row.last_name,
      businessName: row.business_name,
      businessRegistrationNumber: row.business_registration_number,
      operatingLicenceNumber: row.operating_licence_number,
      email: row.email,
      phone: row.phone,
      dateOfBirth: row.date_of_birth,
      nationalIdLast4: row.national_id_last4,
      kycStatus: row.kyc_status,
      employmentStatus: row.employment_status,
      employerName: row.employer_name,
      monthsInEmployment: row.months_in_employment,
      currency: row.currency,
      monthlyIncome: row.monthly_income.toString(),
      monthlyExpenses: row.monthly_expenses.toString(),
      existingMonthlyDebt: row.existing_monthly_debt.toString(),
      createdAt: row.created_at.toISOString(),
    };
  }
}

export class CustomerRegistrationDto {
  @ApiProperty({ type: CustomerDto }) customer!: CustomerDto;
  @ApiProperty({ type: TokenPairDto }) tokens!: TokenPairDto;
}

export class CustomerPageDto extends PageDto(CustomerDto) {}
