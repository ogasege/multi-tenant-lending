import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import { type EndOfDaySummary, EndOfDayService } from '../../application/end-of-day.service';

import { EndOfDayRequestDto, EndOfDaySummaryDto } from './end-of-day.dto';

/** Back-office batch operations (SPEC §10). */
@ApiTags('Operations')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('operations')
export class OperationsController {
  constructor(private readonly endOfDay: EndOfDayService) {}

  @Post('end-of-day')
  @HttpCode(200)
  @RequirePermissions(Permission.OPERATIONS_RUN)
  @ApiOperation({
    summary: 'Run end-of-day for the caller’s institution',
    description:
      'Accrues interest due, assesses late fees after the grace period, refreshes days past ' +
      'due and expires lapsed approvals. Idempotent: re-running a date posts nothing twice.',
  })
  @ApiOkResponse({ type: EndOfDaySummaryDto })
  @ApiProblemResponses(400)
  run(
    @CurrentTenantUser() principal: TenantUser,
    @Body() dto: EndOfDayRequestDto,
  ): Promise<EndOfDaySummary> {
    return this.endOfDay.runForTenant(principal.tenantId, dto.asOf);
  }
}
