import type { DirectoryStatus } from '../domain/directory-entry';

import type { DirectoryProjector } from './directory-projector';

/** Current state of one of this cell's institutions, read from Postgres. */
export interface InstitutionSnapshot {
  institutionId: string;
  slug: string;
  status: DirectoryStatus;
  /** `institutions.updated_at` in microseconds since the epoch. */
  version: number;
}

/** Called for every institution whose projection came back `stale`. */
export type StaleListener = (institution: InstitutionSnapshot) => Promise<void>;

/** Pages through this cell's institutions in slug order (keyset pagination). */
export interface InstitutionSnapshots {
  page(afterSlug: string | undefined, limit: number): Promise<InstitutionSnapshot[]>;
}

export const INSTITUTION_SNAPSHOTS = Symbol('INSTITUTION_SNAPSHOTS');

export interface ReconcileSummary {
  applied: number;
  stale: number;
}

const PAGE_SIZE = 500;

/**
 * Reconciles the directory with this cell's institutions table (the source of truth): every
 * institution is projected with its current state, versioned by `updated_at`. Safe to run
 * at any time and repeatedly; rows the directory already holds at that version (or newer)
 * are left untouched. The worker runs it on start-up and periodically, which also repairs
 * any outbox event the per-event consumer missed, and it backfills tenants registered
 * before the directory existed.
 */
export async function projectPendingInstitutions(
  source: InstitutionSnapshots,
  projector: DirectoryProjector,
  onStale?: StaleListener,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { applied: 0, stale: 0 };
  let after: string | undefined;
  for (;;) {
    const page = await source.page(after, PAGE_SIZE);
    for (const institution of page) {
      const result = await projector.project({
        type: 'institution.status_changed',
        version: institution.version,
        payload: {
          institutionId: institution.institutionId,
          slug: institution.slug,
          status: institution.status,
        },
      });
      if (result === 'applied') summary.applied += 1;
      else if (result === 'stale') {
        summary.stale += 1;
        await onStale?.(institution);
      }
    }
    if (page.length < PAGE_SIZE) return summary;
    after = page[page.length - 1]?.slug;
  }
}
