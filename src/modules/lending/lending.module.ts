import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';

import { GetApplication, ListApplications } from './application/application-queries.use-case';
import { AssessApplication } from './application/assess-application.use-case';
import { ApproveApplication, RejectApplication } from './application/decide-application.use-case';
import { DisburseLoan } from './application/disburse-loan.use-case';
import { LoanAccounting } from './application/loan-accounting';
import {
  GetLoan,
  GetLoanSchedule,
  GetPayoffQuote,
  ListLoans,
  ListRepayments,
} from './application/loan-queries.use-case';
import { LoanServicing } from './application/loan-servicing.service';
import { Clock } from './application/ports/clock.port';
import { RecordRepayment } from './application/record-repayment.use-case';
import { SubmitApplication } from './application/submit-application.use-case';
import { WithdrawApplication } from './application/withdraw-application.use-case';
import { ApplicationsRepository } from './infrastructure/applications.repository';
import { LoansRepository } from './infrastructure/loans.repository';
import {
  checkoutOrdersProvider,
  creditBureauProvider,
  paymentGatewayProvider,
} from './infrastructure/providers';
import { SystemClock } from './infrastructure/system-clock';
import { ApplicationsController } from './interface/http/applications.controller';
import { LoansController } from './interface/http/loans.controller';

/**
 * Lending core (hexagonal, SPEC §3): applications, credit assessment, approval, disbursement,
 * repayments and per-loan servicing. Exports `LoanServicing` (end-of-day steps) and `Clock`
 * for the operations module.
 */
@Module({
  imports: [LedgerModule],
  controllers: [ApplicationsController, LoansController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    // Adapters per PAYMENT_PROVIDER / CREDIT_BUREAU_PROVIDER / CHECKOUT_ORDERS_PROVIDER.
    paymentGatewayProvider,
    creditBureauProvider,
    checkoutOrdersProvider,
    ApplicationsRepository,
    LoansRepository,
    LoanAccounting,
    SubmitApplication,
    ListApplications,
    GetApplication,
    WithdrawApplication,
    AssessApplication,
    ApproveApplication,
    RejectApplication,
    ListLoans,
    GetLoan,
    GetLoanSchedule,
    GetPayoffQuote,
    ListRepayments,
    DisburseLoan,
    RecordRepayment,
    LoanServicing,
  ],
  exports: [LoanServicing, Clock],
})
export class LendingModule {}
