import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { isLogoContentType, isOwnLogoObjectKey } from '../domain/branding-rules';
import { BrandingAssets } from '../infrastructure/branding-assets';
import { BrandingCache } from '../infrastructure/branding-cache';
import {
  type BrandingChanges,
  InstitutionsRepository,
} from '../infrastructure/institutions.repository';

import { type BrandingView, toBrandingView } from './branding.view';

export interface UpdateBrandingCommand {
  tenantId: string;
  expectedVersion: number;
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
  websiteUrl?: string | null;
  locale: string;
  logoObjectKey?: string | null;
}

/**
 * Replaces the tenant's white-label branding.
 *
 * - Optimistic concurrency: the row is locked and its `version` compared with
 *   `expectedVersion`; a mismatch is `CONCURRENT_MODIFICATION` (409) so two admins editing
 *   at once cannot silently overwrite each other.
 * - `logoObjectKey` must be a key this tenant was issued (`tenants/<tenantId>/branding/…`)
 *   and the object must exist with an allowed image type, so branding can never point at
 *   another tenant's asset or at an arbitrary upload.
 * - Branding row + audit (before/after) + outbox event commit together; the public branding
 *   cache entry is dropped after commit.
 */
@Injectable()
export class UpdateBranding {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: InstitutionsRepository,
    private readonly assets: BrandingAssets,
    private readonly cache: BrandingCache,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async execute(cmd: UpdateBrandingCommand): Promise<BrandingView> {
    const logoKey = cmd.logoObjectKey ?? null;
    if (logoKey !== null) await this.assertUsableLogo(cmd.tenantId, logoKey);

    const changes: BrandingChanges = {
      display_name: cmd.displayName.trim(),
      primary_color: cmd.primaryColor.toUpperCase(),
      secondary_color: cmd.secondaryColor.toUpperCase(),
      support_email: cmd.supportEmail ?? null,
      support_phone: cmd.supportPhone ?? null,
      website_url: cmd.websiteUrl ?? null,
      locale: cmd.locale,
      logo_object_key: logoKey,
    };

    const { updated, slug } = await this.runner.run(async (tx) => {
      const institution = await this.repo.findInstitution(tx);
      const before = await this.repo.findBranding(tx, { forUpdate: true });
      if (!institution || !before) throw new NotFoundError('Branding');
      if (before.version !== cmd.expectedVersion) throw staleVersion(before.version);

      const after = await this.repo.updateBranding(tx, cmd.tenantId, cmd.expectedVersion, changes);
      // Unreachable while the row lock is held; kept as a guard for the CAS contract.
      if (!after) throw staleVersion(before.version);

      await this.audit.record(tx, {
        action: 'institution.branding_updated',
        entityType: 'institution_branding',
        entityId: cmd.tenantId,
        before,
        after,
      });
      await this.outbox.publish(tx, {
        type: 'institution.branding_updated',
        aggregateType: 'institution',
        aggregateId: cmd.tenantId,
        data: { version: after.version, updatedAt: after.updated_at.toISOString() },
      });
      return { updated: after, slug: institution.slug };
    });

    await this.cache.invalidate(slug);
    return toBrandingView(updated, this.assets);
  }

  private async assertUsableLogo(tenantId: string, key: string): Promise<void> {
    if (!isOwnLogoObjectKey(tenantId, key)) {
      throw new ValidationError('Invalid logo object key', [
        {
          field: 'logoObjectKey',
          message: 'must be a key issued by POST /v1/institution/branding/logo-upload-url',
        },
      ]);
    }
    const stored = await this.assets.head(key);
    if (!stored) {
      throw new ValidationError('Logo not uploaded', [
        { field: 'logoObjectKey', message: 'no object exists under this key; upload it first' },
      ]);
    }
    if (!isLogoContentType(stored.contentType)) {
      throw new ValidationError('Unsupported logo type', [
        { field: 'logoObjectKey', message: 'object must be image/png, image/jpeg or image/webp' },
      ]);
    }
  }
}

function staleVersion(currentVersion: number): ConflictError {
  return new ConflictError(
    ErrorCode.CONCURRENT_MODIFICATION,
    'Branding was modified by someone else; reload and retry',
    { currentVersion },
  );
}
