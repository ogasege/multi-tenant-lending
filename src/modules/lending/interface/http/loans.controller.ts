import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import type { Page } from '../../../../common/http/pagination';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import { Idempotent } from '../../../../common/idempotency/idempotency.interceptor';
import { DisburseLoan } from '../../application/disburse-loan.use-case';
import type {
  LoanView,
  PayoffQuoteView,
  RepaymentResultView,
  RepaymentView,
  ScheduleView,
} from '../../application/lending.views';
import {
  GetLoan,
  GetLoanSchedule,
  GetPayoffQuote,
  ListLoans,
  ListRepayments,
} from '../../application/loan-queries.use-case';
import { RecordRepayment } from '../../application/record-repayment.use-case';

import { IDEMPOTENCY_HEADER } from './idempotency-key.header';
import {
  ListLoansQueryDto,
  LoanDto,
  LoanPageDto,
  PayoffQueryDto,
  PayoffQuoteDto,
  RecordRepaymentDto,
  RepaymentListDto,
  RepaymentResultDto,
  ScheduleDto,
} from './dto/loan.dto';

/** Loans: servicing reads, disbursement and repayments (SPEC §7, §9, §10). */
@ApiTags('Loans')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('loans')
export class LoansController {
  constructor(
    private readonly list: ListLoans,
    private readonly getOne: GetLoan,
    private readonly schedule: GetLoanSchedule,
    private readonly payoff: GetPayoffQuote,
    private readonly repayments: ListRepayments,
    private readonly disburseOne: DisburseLoan,
    private readonly repay: RecordRepayment,
  ) {}

  @Get()
  @RequirePermissions(Permission.LOAN_READ)
  @ApiOperation({ summary: 'List loans (customers: own only) with status / DPD filters' })
  @ApiOkResponse({ type: LoanPageDto })
  @ApiProblemResponses(400)
  findAll(
    @CurrentTenantUser() principal: TenantUser,
    @Query() query: ListLoansQueryDto,
  ): Promise<Page<LoanView>> {
    return this.list.execute(principal, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOAN_READ)
  @ApiOperation({ summary: 'Get a loan with its outstanding balances' })
  @ApiOkResponse({ type: LoanDto })
  @ApiProblemResponses(400, 404)
  findOne(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LoanView> {
    return this.getOne.execute(principal, id);
  }

  @Get(':id/schedule')
  @RequirePermissions(Permission.LOAN_READ)
  @ApiOperation({ summary: 'Repayment schedule (a preview before disbursement)' })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiProblemResponses(400, 404)
  getSchedule(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduleView> {
    return this.schedule.execute(principal, id);
  }

  @Get(':id/payoff-quote')
  @RequirePermissions(Permission.LOAN_READ)
  @ApiOperation({ summary: 'Early-settlement amount as of a date (future interest waived)' })
  @ApiOkResponse({ type: PayoffQuoteDto })
  @ApiProblemResponses(400, 404, 409)
  payoffQuote(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PayoffQueryDto,
  ): Promise<PayoffQuoteView> {
    return this.payoff.execute(principal, id, query.asOf);
  }

  @Post(':id/disburse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions(Permission.LOAN_DISBURSE)
  @IDEMPOTENCY_HEADER
  @ApiOperation({
    summary: 'Disburse an approved loan to its payee (maker-checker vs the approver)',
  })
  @ApiOkResponse({ type: LoanDto })
  @ApiResponse({ status: 502, description: 'DISBURSEMENT_PROVIDER_FAILED: nothing was posted' })
  @ApiProblemResponses(400, 404, 409, 422)
  disburse(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LoanView> {
    return this.disburseOne.execute(principal, id);
  }

  @Post(':id/repayments')
  @Idempotent()
  @RequirePermissions(Permission.REPAYMENT_CREATE)
  @IDEMPOTENCY_HEADER
  @ApiOperation({
    summary:
      'Record a received repayment (staff; waterfall allocation; the payoff amount closes the loan)',
  })
  @ApiCreatedResponse({ type: RepaymentResultDto })
  @ApiProblemResponses(400, 404, 409, 422)
  createRepayment(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordRepaymentDto,
  ): Promise<RepaymentResultView> {
    return this.repay.execute(principal, id, dto);
  }

  @Get(':id/repayments')
  @RequirePermissions(Permission.LOAN_READ)
  @ApiOperation({ summary: 'Repayments of a loan, oldest first' })
  @ApiOkResponse({ type: RepaymentListDto })
  @ApiProblemResponses(400, 404)
  listRepayments(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: RepaymentView[] }> {
    return this.repayments.execute(principal, id);
  }
}
