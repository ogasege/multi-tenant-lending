import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { ChainVerification } from '../../../../common/audit/audit-writer';
import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import type { Page } from '../../../../common/http/pagination';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import {
  type AuditLogView,
  ListAuditLogs,
  VerifyAuditChain,
} from '../../application/audit-queries.use-case';

import { AuditLogPageDto, AuditLogQueryDto, ChainVerificationDto } from './audit.dto';

/** Tamper-evident audit trail of the caller's institution (SPEC §9). */
@ApiTags('Audit')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly list: ListAuditLogs,
    private readonly verify: VerifyAuditChain,
  ) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  @ApiOperation({ summary: 'List audit entries, newest first (keyset pagination by id)' })
  @ApiOkResponse({ type: AuditLogPageDto })
  @ApiProblemResponses(400)
  findAll(@Query() query: AuditLogQueryDto): Promise<Page<AuditLogView>> {
    return this.list.execute(query);
  }

  @Get('verify')
  @RequirePermissions(Permission.AUDIT_READ)
  @ApiOperation({ summary: 'Recompute the hash chain from genesis and report the first break' })
  @ApiOkResponse({ type: ChainVerificationDto })
  verifyChain(@CurrentTenantUser() principal: TenantUser): Promise<ChainVerification> {
    return this.verify.execute(principal);
  }
}
