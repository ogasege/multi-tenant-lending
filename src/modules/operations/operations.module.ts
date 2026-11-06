import { Module } from '@nestjs/common';

import { LendingModule } from '../lending/lending.module';

import { EndOfDayService } from './application/end-of-day.service';
import { OperationsController } from './interface/http/operations.controller';

/** Batch operations: end-of-day processing (also callable by the worker per tenant). */
@Module({
  imports: [LendingModule],
  controllers: [OperationsController],
  providers: [EndOfDayService],
  exports: [EndOfDayService],
})
export class OperationsModule {}
