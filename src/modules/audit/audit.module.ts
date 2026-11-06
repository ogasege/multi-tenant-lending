import { Module } from '@nestjs/common';

import { ListAuditLogs, VerifyAuditChain } from './application/audit-queries.use-case';
import { AuditController } from './interface/http/audit.controller';

/** Audit trail query and hash-chain verification API (SPEC §9). */
@Module({
  controllers: [AuditController],
  providers: [ListAuditLogs, VerifyAuditChain],
})
export class AuditModule {}
