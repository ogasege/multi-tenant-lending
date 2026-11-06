import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import type {
  ApplicationStatus,
  CreditDecision,
  PayeeType,
} from '../../../../../common/database/schema';
import { PageDto, PageQueryDto } from '../../../../../common/http/pagination';
import type { ApplicationDetailView } from '../../../application/application-queries.use-case';
import type {
  ApplicationView,
  AssessmentView,
  DisclosureView,
  PayeeView,
} from '../../../application/lending.views';
import { REASON_CODES, type ReasonCode } from '../../../domain';

/** Positive integer string (minor units); strings avoid 2^53 precision loss. */
export const POSITIVE_MINOR = /^[1-9]\d{0,17}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PAYEE_TYPES: PayeeType[] = ['VENDOR', 'BORROWER'];
const STATUSES: ApplicationStatus[] = [
  'SUBMITTED',
  'ASSESSED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
];
const DECISIONS: CreditDecision[] = ['APPROVE', 'REFER', 'DECLINE', 'COUNTER_OFFER'];

export class PayeeInputDto {
  @ApiPropertyOptional({
    enum: PAYEE_TYPES,
    description: 'Defaults to the product’s disbursement mode',
  })
  @IsOptional()
  @IsIn(PAYEE_TYPES)
  type?: PayeeType;

  @ApiProperty({ example: 'Emzor Pharmaceuticals Ltd' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: '0123456789', description: 'Bank account / wallet of the payee' })
  @Matches(/^[A-Za-z0-9-]{4,34}$/, { message: 'account must be 4–34 letters, digits or -' })
  account!: string;
}

export class SubmitApplicationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required for staff applying on a customer’s behalf; customers apply for self',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: '100000000', description: 'Requested principal, minor units' })
  @Matches(POSITIVE_MINOR, { message: 'principal must be a positive integer string' })
  principal!: string;

  @ApiProperty({ example: 6, description: 'Instalments, or days for a BULLET product' })
  @IsInt()
  @Min(1)
  @Max(3650)
  term!: number;

  @ApiPropertyOptional({ example: 'Restock of anti-malarials' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;

  @ApiPropertyOptional({
    type: PayeeInputDto,
    description:
      'Required for BORROWER-mode products (a customer may only name a BORROWER payee). For ' +
      'VENDOR-mode (checkout) products the payee is the checkout order’s vendor as resolved ' +
      'by the procurement platform; if sent, it must be that vendor’s account (422 ' +
      'PAYEE_NOT_ALLOWED).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayeeInputDto)
  payee?: PayeeInputDto;

  @ApiPropertyOptional({
    example: 'ORD-2026-000123',
    description:
      'Checkout order id; required for VENDOR-mode products (422 CHECKOUT_ORDER_NOT_FOUND ' +
      'when the procurement platform does not know it; 422 ORDER_NOT_FOR_APPLICANT when it ' +
      'was placed by another customer; 422 ORDER_AMOUNT_EXCEEDED when the principal is above ' +
      'its total). An order backs at most one live application (409 ORDER_ALREADY_FINANCED).',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_.:-]{1,100}$/, { message: 'externalOrderReference has invalid chars' })
  externalOrderReference?: string;
}

export class ListApplicationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: ApplicationStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Staff only; ignored for customers' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class ApproveApplicationDto {
  @ApiPropertyOptional({
    example: '90000000',
    description: 'Defaults to the request (or the counter-offer amount)',
  })
  @IsOptional()
  @Matches(POSITIVE_MINOR, { message: 'approvedPrincipal must be a positive integer string' })
  approvedPrincipal?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class RejectApplicationDto {
  @ApiProperty({ enum: REASON_CODES, isArray: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(REASON_CODES.length)
  @IsIn(REASON_CODES, { each: true })
  reasonCodes!: ReasonCode[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class PayeeDto implements PayeeView {
  @ApiProperty({ enum: PAYEE_TYPES }) type!: PayeeType;
  @ApiProperty() name!: string;
  @ApiProperty() account!: string;
}

export class ApplicationDto implements ApplicationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'APP-7KQ2MX' }) reference!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) productVersionId!: string;
  @ApiProperty({ example: 'NGN' }) currency!: string;
  @ApiProperty({ example: '100000000' }) requestedPrincipal!: string;
  @ApiProperty() term!: number;
  @ApiProperty({ type: String, nullable: true }) purpose!: string | null;
  @ApiProperty({ type: PayeeDto }) payee!: PayeeDto;
  @ApiProperty({ type: String, nullable: true }) externalOrderReference!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: ApplicationStatus;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'null for customers' })
  submittedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) decidedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) decisionNotes!: string | null;
  @ApiProperty({ type: [String] }) rejectionReasonCodes!: string[];
  @ApiProperty({ type: String, nullable: true }) approvedPrincipal!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) loanId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AssessmentSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DECISIONS }) decision!: string;
  @ApiProperty({ type: String, nullable: true, example: 'A', description: 'null for customers' })
  grade!: string | null;
  @ApiProperty({ type: [String] }) reasonCodes!: string[];
  @ApiProperty({ type: Number, nullable: true }) aprBps!: number | null;
  @ApiProperty({ type: String, nullable: true }) maxAffordablePrincipal!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ApplicationDetailDto extends ApplicationDto implements ApplicationDetailView {
  @ApiProperty({ type: AssessmentSummaryDto, nullable: true })
  latestAssessment!: AssessmentSummaryDto | null;
}

export class ApplicationPageDto extends PageDto(ApplicationDto) {}

export class DisclosureDto implements DisclosureView {
  @ApiProperty({ example: 'NGN' }) currency!: string;
  @ApiProperty({ example: '100000000' }) principal!: string;
  @ApiProperty({ example: '2000000' }) originationFee!: string;
  @ApiProperty({ example: 'DEDUCTED' }) originationFeeTreatment!: string;
  @ApiProperty({ example: '100000000' }) financedPrincipal!: string;
  @ApiProperty({ example: '98000000' }) netDisbursed!: string;
  @ApiProperty({ example: 6 }) numberOfInstalments!: number;
  @ApiProperty({ example: '17852581' }) instalmentAmount!: string;
  @ApiProperty() totalInterest!: string;
  @ApiProperty() totalRepayable!: string;
  @ApiProperty({ description: 'Total repayable − net disbursed' }) totalCostOfCredit!: string;
  @ApiProperty({ example: 3150, description: 'All-in APR, basis points' }) aprBps!: number;
  @ApiProperty({ format: 'date' }) firstDueDate!: string;
  @ApiProperty({ format: 'date' }) maturityDate!: string;
}

export class AssessmentDto implements AssessmentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) applicationId!: string;
  @ApiProperty({ example: 'scorecard-v1' }) modelVersion!: string;
  @ApiProperty({ enum: DECISIONS }) decision!: CreditDecision;
  @ApiProperty({ example: 'A' }) grade!: string;
  @ApiProperty() points!: number;
  @ApiProperty({ enum: REASON_CODES, isArray: true }) reasonCodes!: string[];
  @ApiProperty() bureauScore!: number;
  @ApiProperty() bureauDelinquent!: boolean;
  @ApiProperty({ example: 1190 }) dtiBps!: number;
  @ApiProperty() instalmentAmount!: string;
  @ApiProperty({ type: String, nullable: true }) maxAffordablePrincipal!: string | null;
  @ApiProperty({ type: Number, nullable: true }) aprBps!: number | null;
  @ApiProperty({ format: 'uuid' }) assessedBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: DisclosureDto }) disclosure!: DisclosureDto;
}
