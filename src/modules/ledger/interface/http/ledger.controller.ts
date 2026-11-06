import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import {
  GetLoanLedger,
  GetTrialBalance,
  type LoanLedgerView,
  type TrialBalanceView,
} from '../../application/ledger-queries.use-case';

import { LoanLedgerDto, TrialBalanceDto, TrialBalanceQueryDto } from './ledger.dto';

/** Read side of the double-entry ledger (SPEC §8). */
@ApiTags('Ledger')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller()
export class LedgerController {
  constructor(
    private readonly loanLedger: GetLoanLedger,
    private readonly trialBalance: GetTrialBalance,
  ) {}

  @Get('loans/:id/ledger')
  @RequirePermissions(Permission.LEDGER_READ)
  @ApiOperation({ summary: 'Journal entries and postings of one loan' })
  @ApiOkResponse({ type: LoanLedgerDto })
  @ApiProblemResponses(400, 404)
  forLoan(@Param('id', ParseUUIDPipe) id: string): Promise<LoanLedgerView> {
    return this.loanLedger.execute(id);
  }

  @Get('ledger/trial-balance')
  @RequirePermissions(Permission.LEDGER_READ)
  @ApiOperation({
    summary: 'Trial balance per account with the proof Σ debits = Σ credits',
  })
  @ApiOkResponse({ type: TrialBalanceDto })
  @ApiProblemResponses(400, 422)
  get(@Query() query: TrialBalanceQueryDto): Promise<TrialBalanceView> {
    return this.trialBalance.execute(query.currency);
  }
}
