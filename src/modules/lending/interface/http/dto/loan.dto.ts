import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

import type {
  DpdBucket,
  InstalmentStatus,
  LoanStatus,
  LoanTermsSnapshot,
  RepaymentChannel,
} from '../../../../../common/database/schema';
import { PageDto, PageQueryDto } from '../../../../../common/http/pagination';
import type { ApprovalView } from '../../../application/decide-application.use-case';
import type {
  InstalmentView,
  LoanView,
  OutstandingView,
  PayoffQuoteView,
  RepaymentResultView,
  RepaymentView,
  ScheduleView,
} from '../../../application/lending.views';

import {
  ApplicationDto,
  DisclosureDto,
  ISO_DATE,
  PayeeDto,
  POSITIVE_MINOR,
} from './application.dto';

const LOAN_STATUSES: LoanStatus[] = [
  'PENDING_DISBURSEMENT',
  'ACTIVE',
  'CLOSED',
  'CANCELLED',
  'WRITTEN_OFF',
];
const BUCKETS: DpdBucket[] = ['CURRENT', 'DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS'];
const CHANNELS: RepaymentChannel[] = [
  'BANK_TRANSFER',
  'CARD',
  'DIRECT_DEBIT',
  'MOBILE_MONEY',
  'CASH',
];
const INSTALMENT_STATUSES: InstalmentStatus[] = ['PENDING', 'PARTIALLY_PAID', 'PAID', 'WAIVED'];

export class ListLoansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: LOAN_STATUSES })
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  status?: LoanStatus;

  @ApiPropertyOptional({ enum: BUCKETS })
  @IsOptional()
  @IsIn(BUCKETS)
  dpdBucket?: DpdBucket;

  @ApiPropertyOptional({ minimum: 0, description: 'Only loans at least this many days past due' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(36_500)
  minDaysPastDue?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Staff only; ignored for customers' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class PayoffQueryDto {
  @ApiPropertyOptional({ format: 'date', description: 'Defaults to the business date today' })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'asOf must be a YYYY-MM-DD date' })
  asOf?: string;
}

export class RecordRepaymentDto {
  @ApiProperty({ example: '20000000', description: 'Amount paid, minor units' })
  @Matches(POSITIVE_MINOR, { message: 'amount must be a positive integer string' })
  amount!: string;

  @ApiProperty({ enum: CHANNELS })
  @IsIn(CHANNELS)
  channel!: RepaymentChannel;

  @ApiPropertyOptional({
    example: 'NIP-000123456789',
    description:
      'Provider / bank statement reference, unique per institution (409 DUPLICATE). ' +
      'Required for every channel except CASH (422 EXTERNAL_REFERENCE_REQUIRED)',
  })
  @IsOptional()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_.:-]{1,100}$/, { message: 'externalReference has invalid characters' })
  externalReference?: string;

  @ApiPropertyOptional({
    format: 'date',
    description:
      'Date the money was received; defaults to business today. Must be on or after the ' +
      'disbursement date and the latest recorded repayment’s value date, at most ' +
      'REPAYMENT_MAX_BACKDATE_DAYS (default 3) before today, never in the future ' +
      '(422 VALUE_DATE_OUT_OF_RANGE)',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'valueDate must be a YYYY-MM-DD date' })
  valueDate?: string;
}

export class OutstandingDto implements OutstandingView {
  @ApiProperty() principal!: string;
  @ApiProperty() interest!: string;
  @ApiProperty() fees!: string;
  @ApiProperty() penalties!: string;
  @ApiProperty() total!: string;
}

class FeeSnapshotDto {
  @ApiProperty() type!: string;
  @ApiProperty() value!: string;
  @ApiPropertyOptional() treatment?: string;
  @ApiPropertyOptional() graceDays?: number;
}

export class LoanTermsDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) productVersionId!: string;
  @ApiProperty() productVersion!: number;
  @ApiProperty() productCode!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() term!: number;
  @ApiProperty() repaymentFrequency!: string;
  @ApiProperty() interestMethod!: string;
  @ApiProperty() annualInterestRateBps!: number;
  @ApiProperty() dayCount!: string;
  @ApiProperty({ type: FeeSnapshotDto }) originationFee!: FeeSnapshotDto;
  @ApiProperty({ type: FeeSnapshotDto }) lateFee!: FeeSnapshotDto;
}

export class LoanDto implements LoanView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'LN-9XH4TB' }) reference!: string;
  @ApiProperty({ format: 'uuid' }) applicationId!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty({ format: 'uuid' }) productVersionId!: string;
  @ApiProperty({ example: 'NGN' }) currency!: string;
  @ApiProperty() approvedPrincipal!: string;
  @ApiProperty() financedPrincipal!: string;
  @ApiProperty() originationFee!: string;
  @ApiProperty() netDisbursed!: string;
  @ApiProperty({ type: Number, nullable: true }) aprBps!: number | null;
  @ApiProperty({ type: LoanTermsDto }) terms!: LoanTermsSnapshot;
  @ApiProperty({ type: PayeeDto }) payee!: PayeeDto;
  @ApiProperty({ enum: LOAN_STATUSES }) status!: LoanStatus;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'null for customers' })
  approvedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) approvedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) disbursedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) disbursedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) disbursementDate!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) maturityDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerReference!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) closedAt!: string | null;
  @ApiProperty() daysPastDue!: number;
  @ApiProperty({ enum: BUCKETS }) dpdBucket!: DpdBucket;
  @ApiProperty({ type: OutstandingDto }) outstanding!: OutstandingDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class LoanPageDto extends PageDto(LoanDto) {}

export class ApprovalDto implements ApprovalView {
  @ApiProperty({ type: ApplicationDto }) application!: ApplicationDto;
  @ApiProperty({ type: LoanDto }) loan!: LoanDto;
  @ApiProperty({ type: DisclosureDto }) disclosure!: DisclosureDto;
}

export class InstalmentDto implements InstalmentView {
  @ApiProperty() seq!: number;
  @ApiProperty({ format: 'date' }) dueDate!: string;
  @ApiProperty() principalDue!: string;
  @ApiProperty() interestDue!: string;
  @ApiProperty() feeDue!: string;
  @ApiProperty() penaltyDue!: string;
  @ApiProperty() principalPaid!: string;
  @ApiProperty() interestPaid!: string;
  @ApiProperty() feePaid!: string;
  @ApiProperty() penaltyPaid!: string;
  @ApiProperty() interestWaived!: string;
  @ApiProperty() totalDue!: string;
  @ApiProperty() totalOutstanding!: string;
  @ApiProperty({ enum: INSTALMENT_STATUSES }) status!: InstalmentStatus;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) paidAt!: string | null;
}

export class ScheduleDto implements ScheduleView {
  @ApiProperty({ format: 'uuid' }) loanId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'True before disbursement (priced as if disbursed today)' })
  preview!: boolean;
  @ApiProperty({ format: 'date' }) disbursementDate!: string;
  @ApiProperty({ format: 'date' }) maturityDate!: string;
  @ApiProperty({ type: [InstalmentDto] }) instalments!: InstalmentDto[];
}

export class PayoffQuoteDto implements PayoffQuoteView {
  @ApiProperty({ format: 'uuid' }) loanId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: 'date' }) asOf!: string;
  @ApiProperty() principal!: string;
  @ApiProperty() interest!: string;
  @ApiProperty() fees!: string;
  @ApiProperty() penalties!: string;
  @ApiProperty({ description: 'Pay exactly this to settle and close the loan' }) total!: string;
  @ApiProperty({ description: 'Future interest waived on settlement' }) waivedInterest!: string;
}

class AllocationDto {
  @ApiProperty() principal!: string;
  @ApiProperty() interest!: string;
  @ApiProperty() fee!: string;
  @ApiProperty() penalty!: string;
}

export class RepaymentDto implements RepaymentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) loanId!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: 'date' }) valueDate!: string;
  @ApiProperty({ enum: CHANNELS }) channel!: RepaymentChannel;
  @ApiProperty({ type: String, nullable: true }) externalReference!: string | null;
  @ApiProperty({ type: AllocationDto }) allocation!: AllocationDto;
  @ApiProperty({ format: 'uuid' }) journalEntryId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'null for customers' })
  recordedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class RepaymentResultDto extends RepaymentDto implements RepaymentResultView {
  @ApiProperty({ description: 'The payment settled and closed the loan' }) settled!: boolean;
  @ApiProperty() waivedInterest!: string;
  @ApiProperty({ enum: LOAN_STATUSES }) loanStatus!: LoanStatus;
  @ApiProperty() daysPastDue!: number;
  @ApiProperty({ type: OutstandingDto }) outstanding!: OutstandingDto;
}

export class RepaymentListDto {
  @ApiProperty({ type: [RepaymentDto] }) items!: RepaymentDto[];
}
