import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

import type { AccountType, Direction, JournalKind } from '../../../../common/database/schema';
import type {
  AccountBalanceView,
  JournalEntryView,
  LoanLedgerView,
  PostingView,
  TrialBalanceView,
} from '../../application/ledger-queries.use-case';

const DIRECTIONS: Direction[] = ['DEBIT', 'CREDIT'];
const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const KINDS: JournalKind[] = [
  'DISBURSEMENT',
  'INTEREST_ACCRUAL',
  'LATE_FEE',
  'REPAYMENT',
  'WRITE_OFF',
  'REVERSAL',
];

export class TrialBalanceQueryDto {
  @ApiPropertyOptional({ example: 'NGN', description: 'Defaults to the institution currency' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;
}

export class PostingDto implements PostingView {
  @ApiProperty({ example: '1100' }) accountCode!: string;
  @ApiProperty({ example: 'Loan Principal Receivable' }) accountName!: string;
  @ApiProperty({ enum: DIRECTIONS }) direction!: Direction;
  @ApiProperty({ example: '100000000', description: 'Minor units' }) amount!: string;
}

export class JournalEntryDto implements JournalEntryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: KINDS }) kind!: JournalKind;
  @ApiProperty({ format: 'date' }) effectiveDate!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ example: 'disbursement:3f0c…' }) idempotencyRef!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) reversesEntryId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: [PostingDto] }) postings!: PostingDto[];
}

export class AccountBalanceDto implements AccountBalanceView {
  @ApiProperty({ example: '1000' }) code!: string;
  @ApiProperty({ example: 'Settlement / Cash' }) name!: string;
  @ApiProperty({ enum: ACCOUNT_TYPES }) type!: AccountType;
  @ApiProperty({ enum: DIRECTIONS }) normalBalance!: Direction;
  @ApiProperty({ example: '0' }) debits!: string;
  @ApiProperty({ example: '98000000' }) credits!: string;
  @ApiProperty({ example: '-98000000', description: 'Net, in the normal direction' })
  balance!: string;
}

export class LoanLedgerDto implements LoanLedgerView {
  @ApiProperty({ format: 'uuid' }) loanId!: string;
  @ApiProperty({ example: 'NGN' }) currency!: string;
  @ApiProperty({ type: [JournalEntryDto] }) entries!: JournalEntryDto[];
  @ApiProperty({ type: [AccountBalanceDto] }) balances!: AccountBalanceDto[];
}

export class TrialBalanceDto implements TrialBalanceView {
  @ApiProperty({ example: 'NGN' }) currency!: string;
  @ApiProperty({ type: [AccountBalanceDto] }) accounts!: AccountBalanceDto[];
  @ApiProperty({ example: '250000000' }) totalDebits!: string;
  @ApiProperty({ example: '250000000' }) totalCredits!: string;
  @ApiProperty({ description: 'Σ debits = Σ credits' }) balanced!: boolean;
}
