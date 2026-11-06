import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

import type { EndOfDaySummary } from '../../application/end-of-day.service';

export class EndOfDayRequestDto {
  @ApiProperty({ example: '2026-11-06', description: 'Business date to close (not in the future)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'asOf must be a YYYY-MM-DD date' })
  asOf!: string;
}

export class EndOfDaySummaryDto implements EndOfDaySummary {
  @ApiProperty({ format: 'date' }) asOf!: string;
  @ApiProperty() loansProcessed!: number;
  @ApiProperty({ description: 'Busy loans left for the next run' }) loansSkipped!: number;
  @ApiProperty({ type: [String] }) loansFailed!: string[];
  @ApiProperty({ type: [String], description: 'Lapsed approvals whose expiry failed' })
  applicationsFailed!: string[];
  @ApiProperty() interestAccruals!: number;
  @ApiProperty() lateFees!: number;
  @ApiProperty() delinquencyUpdates!: number;
  @ApiProperty() applicationsExpired!: number;
  @ApiProperty() loansCancelled!: number;
}
