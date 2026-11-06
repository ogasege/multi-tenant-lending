import { Injectable } from '@nestjs/common';

import { TenantResolver } from '../../../common/database/tenant-resolver';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { isValidSlug } from '../domain/branding-rules';
import { BrandingAssets } from '../infrastructure/branding-assets';
import { BrandingCache, type PublicBranding } from '../infrastructure/branding-cache';
import { InstitutionsRepository } from '../infrastructure/institutions.repository';

/**
 * Public white-label configuration for a front end, looked up by institution slug.
 *
 * Unknown, malformed and SUSPENDED slugs all yield the same 404, so the endpoint is not an
 * oracle for which institutions exist. The response never contains the tenant id.
 * Cache-aside in Redis for 60 s; `UpdateBranding` invalidates the entry.
 */
@Injectable()
export class GetPublicBranding {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly resolver: TenantResolver,
    private readonly repo: InstitutionsRepository,
    private readonly assets: BrandingAssets,
    private readonly cache: BrandingCache,
  ) {}

  async execute(slug: string): Promise<PublicBranding> {
    if (!isValidSlug(slug)) throw new NotFoundError('Institution');

    const cached = await this.cache.get(slug);
    if (cached) return cached;

    const institution = await this.resolver.institutionBySlug(slug);
    if (institution?.status !== 'ACTIVE') throw new NotFoundError('Institution');

    const row = await this.runner.runForTenant(institution.id, (tx) => this.repo.findBranding(tx));
    if (!row) throw new NotFoundError('Institution');

    const branding: PublicBranding = {
      slug,
      displayName: row.display_name,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      locale: row.locale,
      supportEmail: row.support_email,
      supportPhone: row.support_phone,
      websiteUrl: row.website_url,
      logoUrl: row.logo_object_key ? await this.assets.presignDownload(row.logo_object_key) : null,
    };
    await this.cache.set(branding);
    return branding;
  }
}
