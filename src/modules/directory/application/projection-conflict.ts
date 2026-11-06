import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import type { DirectoryEntry } from '../domain/directory-entry';

import { DirectoryLookup } from './directory-lookup';

/** What a `stale` projection ran into when the slug's directory row is not ours. */
export interface ProjectionConflict {
  slug: string;
  institutionId: string;
  /** Unknown when the row is not readable as a valid entry (e.g. a PENDING reservation). */
  ownerInstitutionId: string | null;
  ownerHomeRegion: string | null;
}

/**
 * `stale` is normal for redelivered or out-of-order events (the row already holds this
 * institution at a newer version). It is a CONFLICT when the slug's row belongs to another
 * institution or another cell: this cell's tenant is then not routable globally, which must
 * be alarmed on (log event `directory.projection_conflict`).
 *
 * Call it only after a `stale` result, with the entry as lookups see it now. A `stale` write
 * means a row exists; if lookups cannot see it (another cell's PENDING reservation, or a row
 * whose origin this cell does not trust) the slug is not ours either.
 */
export function projectionConflict(
  slug: string,
  entry: DirectoryEntry | undefined,
  institutionId: string,
  cellRegion: string,
): ProjectionConflict | undefined {
  if (!entry) {
    return { slug, institutionId, ownerInstitutionId: null, ownerHomeRegion: null };
  }
  if (entry.institutionId === institutionId && entry.homeRegion === cellRegion) return undefined;
  return {
    slug: entry.slug,
    institutionId,
    ownerInstitutionId: entry.institutionId,
    ownerHomeRegion: entry.homeRegion,
  };
}

/**
 * Logs `directory.projection_conflict` (warn) after a `stale` projection when the slug's
 * directory row belongs to another institution or cell. Shared by the outbox relay
 * (per-event projection) and the periodic reconciler.
 */
@Injectable()
export class ProjectionConflictReporter {
  private readonly logger = new Logger(ProjectionConflictReporter.name);

  constructor(
    private readonly directory: DirectoryLookup,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  /** `context` is merged into the log record (e.g. the outbox event id and type). */
  async reportIfConflicting(
    slug: string,
    institutionId: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    // Bypass the 60 s cache: the decision must reflect the directory as it is now.
    await this.directory.invalidate(slug);
    const conflict = projectionConflict(
      slug,
      await this.directory.find(slug),
      institutionId,
      this.config.CELL_REGION,
    );
    if (!conflict) return;
    this.logger.warn({
      msg: 'directory.projection_conflict',
      event: 'directory.projection_conflict',
      ...context,
      cellRegion: this.config.CELL_REGION,
      ...conflict,
    });
  }
}
