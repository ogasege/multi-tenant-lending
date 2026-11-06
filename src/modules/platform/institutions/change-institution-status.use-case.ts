import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { AccessRevocations } from '../../../common/auth/access-revocations';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { DirectoryLookup } from '../../directory/application/directory-lookup';
import { BrandingCache } from '../../institutions/infrastructure/branding-cache';

import { type ChangeInstitutionStatusDto, InstitutionDto } from './institution.dto';

/**
 * Suspends or reactivates an institution. Audited in the affected tenant's chain.
 *
 * Suspension takes effect immediately:
 *  - every refresh token of the tenant is revoked (sign-in and refresh reject suspended
 *    institutions from then on);
 *  - its outstanding access tokens are invalidated through `AccessRevocations` (written
 *    inside the transaction: if Redis is down the change is rolled back and reported);
 *  - after commit, this cell's public branding and directory lookup caches for the slug are
 *    dropped, so public endpoints stop serving the tenant without waiting for the TTL.
 */
@Injectable()
export class ChangeInstitutionStatus {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly revocations: AccessRevocations,
    private readonly branding: BrandingCache,
    private readonly directory: DirectoryLookup,
  ) {}

  async execute(institutionId: string, dto: ChangeInstitutionStatusDto): Promise<InstitutionDto> {
    // The id is authorised by the platform-admin token; pinning it as the tenant lets the
    // audit row and token revocation pass that tenant's RLS policies.
    const result = await this.runner.asPlatformAdmin(
      async (tx) => {
        const current = await tx
          .selectFrom('institutions')
          .selectAll()
          .where('id', '=', institutionId)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw new NotFoundError('Institution', institutionId);
        if (current.status === dto.status) {
          return { institution: InstitutionDto.from(current), changed: false };
        }

        const updated = await tx
          .updateTable('institutions')
          .set({ status: dto.status })
          .where('id', '=', institutionId)
          .returningAll()
          .executeTakeFirstOrThrow();

        if (dto.status === 'SUSPENDED') {
          // Explicit tenant filter (defence in depth on top of the pinned-tenant RLS).
          await tx
            .updateTable('refresh_tokens')
            .set({ revoked_at: new Date() })
            .where('tenant_id', '=', institutionId)
            .where('revoked_at', 'is', null)
            .execute();
          await this.revocations.suspendTenant(institutionId);
        } else {
          await this.revocations.reactivateTenant(institutionId);
        }

        await this.audit.record(tx, {
          tenantId: institutionId,
          action: 'institution.status_changed',
          entityType: 'institution',
          entityId: institutionId,
          before: { status: current.status },
          after: { status: updated.status, reason: dto.reason },
        });
        await this.outbox.publish(tx, {
          tenantId: institutionId,
          type: 'institution.status_changed',
          aggregateType: 'institution',
          aggregateId: institutionId,
          data: { institutionId, from: current.status, to: updated.status },
        });
        return { institution: InstitutionDto.from(updated), changed: true };
      },
      { tenantId: institutionId },
    );

    if (result.changed) {
      // Best effort (both caches log and swallow Redis errors; TTLs bound staleness to 60 s).
      await Promise.all([
        this.branding.invalidate(result.institution.slug),
        this.directory.invalidate(result.institution.slug),
      ]);
    }
    return result.institution;
  }
}
