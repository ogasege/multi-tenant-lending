import { Module } from '@nestjs/common';

import { GetLoanLedger, GetTrialBalance } from './application/ledger-queries.use-case';
import { LedgerService } from './application/ledger.service';
import { LedgerController } from './interface/http/ledger.controller';

/**
 * Double-entry ledger (SPEC §8): posting service used by lending in the business transaction,
 * and the loan journal / trial balance read APIs.
 */
@Module({
  controllers: [LedgerController],
  providers: [LedgerService, GetLoanLedger, GetTrialBalance],
  exports: [LedgerService],
})
export class LedgerModule {}
