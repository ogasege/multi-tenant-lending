import type { CellEndpoint, DirectoryEntry } from '../domain/directory-entry';

/** Result of a conditional directory write. */
export type UpsertResult = 'applied' | 'stale';

/** A cell's claim on a slug while that institution's registration is in flight. */
export interface SlugReservation {
  slug: string;
  institutionId: string;
  homeRegion: string;
  apiBaseUrl: string;
}

export type ReserveResult = 'reserved' | 'taken';

/**
 * Port to the global tenant directory (DynamoDB global table in AWS, LocalStack in tests).
 * Reads are local to the cell's region; the table replicates across cells.
 */
export interface TenantDirectory {
  get(slug: string): Promise<DirectoryEntry | undefined>;

  /**
   * Writes `entry` only if no row exists for its slug, or the stored row belongs to the SAME
   * institution in the SAME home region and has a LOWER `version`. Returns `stale` (and
   * changes nothing) for duplicates, out-of-order events and slugs owned by anyone else — a
   * cell can never take over another cell's (or another institution's) slug.
   */
  upsert(entry: DirectoryEntry): Promise<UpsertResult>;

  /**
   * Globally reserves a slug for an institution being registered (a `PENDING` row), unless
   * any other row holds it. A `PENDING` row of the SAME cell may be replaced (an earlier
   * attempt that crashed before releasing it); the cell's own database still guarantees
   * local uniqueness. `PENDING` rows are never returned by `get`.
   */
  reserve(reservation: SlugReservation): Promise<ReserveResult>;

  /** Deletes this institution's `PENDING` reservation, if still present (best effort). */
  release(slug: string, institutionId: string): Promise<void>;

  /** Registers (or refreshes) this cell's endpoint; idempotent. */
  putCell(cell: CellEndpoint): Promise<void>;
}

export const TENANT_DIRECTORY = Symbol('TENANT_DIRECTORY');
