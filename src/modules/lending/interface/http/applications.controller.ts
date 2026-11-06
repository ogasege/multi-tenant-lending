import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
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
import {
  type ApplicationDetailView,
  GetApplication,
  ListApplications,
} from '../../application/application-queries.use-case';
import { AssessApplication } from '../../application/assess-application.use-case';
import {
  ApproveApplication,
  type ApprovalView,
  RejectApplication,
} from '../../application/decide-application.use-case';
import type { ApplicationView, AssessmentView } from '../../application/lending.views';
import { SubmitApplication } from '../../application/submit-application.use-case';
import { WithdrawApplication } from '../../application/withdraw-application.use-case';

import { IDEMPOTENCY_HEADER } from './idempotency-key.header';
import {
  ApplicationDetailDto,
  ApplicationDto,
  ApplicationPageDto,
  ApproveApplicationDto,
  AssessmentDto,
  ListApplicationsQueryDto,
  RejectApplicationDto,
  SubmitApplicationDto,
} from './dto/application.dto';
import { ApprovalDto } from './dto/loan.dto';

/** Loan applications: submit → assess → approve / reject, or withdraw (SPEC §7.2, §10). */
@ApiTags('Loan applications')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('loan-applications')
export class ApplicationsController {
  constructor(
    private readonly submit: SubmitApplication,
    private readonly list: ListApplications,
    private readonly getOne: GetApplication,
    private readonly withdrawOne: WithdrawApplication,
    private readonly assessOne: AssessApplication,
    private readonly approveOne: ApproveApplication,
    private readonly rejectOne: RejectApplication,
  ) {}

  @Post()
  @Idempotent()
  @RequirePermissions(Permission.APPLICATION_CREATE)
  @IDEMPOTENCY_HEADER
  @ApiOperation({
    summary: 'Apply for a loan (customers for themselves, credit officers for a customer)',
  })
  @ApiCreatedResponse({ type: ApplicationDto })
  @ApiProblemResponses(400, 404, 422)
  create(
    @CurrentTenantUser() principal: TenantUser,
    @Body() dto: SubmitApplicationDto,
  ): Promise<ApplicationView> {
    return this.submit.execute(principal, dto);
  }

  @Get()
  @RequirePermissions(Permission.APPLICATION_READ)
  @ApiOperation({ summary: 'List applications (customers: own only), newest first' })
  @ApiOkResponse({ type: ApplicationPageDto })
  @ApiProblemResponses(400)
  findAll(
    @CurrentTenantUser() principal: TenantUser,
    @Query() query: ListApplicationsQueryDto,
  ): Promise<Page<ApplicationView>> {
    return this.list.execute(principal, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.APPLICATION_READ)
  @ApiOperation({ summary: 'Get an application with its latest assessment' })
  @ApiOkResponse({ type: ApplicationDetailDto })
  @ApiProblemResponses(400, 404)
  findOne(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationDetailView> {
    return this.getOne.execute(principal, id);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequirePermissions(Permission.APPLICATION_CREATE)
  @ApiOperation({ summary: 'Withdraw your own SUBMITTED or ASSESSED application' })
  @ApiOkResponse({ type: ApplicationDto })
  @ApiProblemResponses(400, 404, 409)
  withdraw(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationView> {
    return this.withdrawOne.execute(principal, id);
  }

  @Post(':id/assess')
  @HttpCode(200)
  @RequirePermissions(Permission.APPLICATION_ASSESS)
  @ApiOperation({
    summary: 'Run the credit assessment (scorecard-v1) and return the cost-of-credit disclosure',
  })
  @ApiOkResponse({ type: AssessmentDto })
  @ApiProblemResponses(400, 404, 409)
  assess(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssessmentView> {
    return this.assessOne.execute(principal, id);
  }

  @Post(':id/approve')
  @Idempotent()
  @RequirePermissions(Permission.APPLICATION_DECIDE)
  @IDEMPOTENCY_HEADER
  @ApiOperation({
    summary: 'Approve an assessed application and book the loan (maker-checker, APR cap)',
  })
  @ApiCreatedResponse({ type: ApprovalDto })
  @ApiProblemResponses(400, 404, 409, 422)
  approve(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
  ): Promise<ApprovalView> {
    return this.approveOne.execute(principal, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions(Permission.APPLICATION_DECIDE)
  @ApiOperation({ summary: 'Reject an application with adverse-action reason codes' })
  @ApiOkResponse({ type: ApplicationDto })
  @ApiProblemResponses(400, 404, 409)
  reject(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
  ): Promise<ApplicationView> {
    return this.rejectOne.execute(principal, id, dto);
  }
}
