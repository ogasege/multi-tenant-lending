import { Inject, Injectable } from '@nestjs/common';

import type { CellLocator } from '../../../common/auth/cell-locator';
import { trustedCellOrigin } from '../../../config/cell-origins';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import {
  DIRECTORY_STATUSES,
  type DirectoryEntry,
  isValidRegion,
  isValidSlug,
  parseApiBaseUrl,
} from '../domain/directory-entry';
import { type Cached, DirectoryCache } from '../infrastructure/directory-cache';

import { TENANT_DIRECTORY, type TenantDirectory } from './tenant-directory.port';

/**
 * Read side of the directory: Redis cache-aside (60 s) over the regional DynamoDB replica.
 * Entries are validated on the way out — a row with a malformed slug, region or status, or a
 * base URL that is not the CONFIGURED origin of its home region (`CELL_ORIGINS`), is treated
 * as absent, so nothing downstream ever redirects to it.
 */
@Injectable()
export class DirectoryLookup implements CellLocator {
  private readonly allowInsecure: boolean;

  constructor(
    @Inject(TENANT_DIRECTORY) private readonly directory: TenantDirectory,
    private readonly cache: DirectoryCache,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {
    this.allowInsecure = config.NODE_ENV === 'test' || config.NODE_ENV === 'development';
  }

  async find(slug: string): Promise<DirectoryEntry | undefined> {
    if (!isValidSlug(slug)) return undefined;
    const cached = await this.cache.getEntry(slug);
    if (cached !== undefined) return cached ?? undefined;

    const entry = this.sanitise(await this.directory.get(slug));
    await this.cache.setEntry(slug, entry ?? null);
    return entry;
  }

  /** The cached lookup only (no DynamoDB): `null` = known miss, `undefined` = not cached. */
  peek(slug: string): Promise<Cached<DirectoryEntry>> {
    if (!isValidSlug(slug)) return Promise.resolve(null);
    return this.cache.getEntry(slug);
  }

  /**
   * The base URL of the cell serving `region` — from configuration only, so a 421 can only
   * ever point at a configured cell.
   */
  apiBaseUrlFor(region: string): Promise<string | undefined> {
    return Promise.resolve(this.trustedOrigin(region));
  }

  /** Configured origin of a region's cell (`undefined` = not a cell we trust). */
  trustedOrigin(region: string): string | undefined {
    return trustedCellOrigin(this.config, region);
  }

  invalidate(slug: string): Promise<void> {
    return this.cache.invalidate(slug);
  }

  private sanitise(entry: DirectoryEntry | undefined): DirectoryEntry | undefined {
    if (!entry) return undefined;
    const apiBaseUrl = parseApiBaseUrl(entry.apiBaseUrl, this.allowInsecure);
    const valid =
      apiBaseUrl !== undefined &&
      isValidSlug(entry.slug) &&
      isValidRegion(entry.homeRegion) &&
      apiBaseUrl === this.trustedOrigin(entry.homeRegion) &&
      DIRECTORY_STATUSES.includes(entry.status);
    return valid ? { ...entry, apiBaseUrl } : undefined;
  }
}
