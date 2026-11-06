import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../../common/errors/app-error';
import type { DirectoryStatus } from '../domain/directory-entry';

import { DirectoryLookup } from './directory-lookup';

/** Public view of a directory entry: where a tenant lives. No institution id. */
export interface DirectoryEntryView {
  slug: string;
  homeRegion: string;
  apiBaseUrl: string;
  status: DirectoryStatus;
}

/**
 * Resolves the home cell of an institution slug. Unknown AND suspended slugs are the same
 * 404, so the public lookup does not disclose that a lender was suspended (cell routing
 * keeps using the internal entry, so the home cell still answers for suspended tenants).
 */
@Injectable()
export class GetDirectoryEntry {
  constructor(private readonly lookup: DirectoryLookup) {}

  async execute(slug: string): Promise<DirectoryEntryView> {
    const entry = await this.lookup.find(slug);
    if (entry?.status !== 'ACTIVE') throw new NotFoundError('Institution');
    return {
      slug: entry.slug,
      homeRegion: entry.homeRegion,
      apiBaseUrl: entry.apiBaseUrl,
      status: entry.status,
    };
  }
}
