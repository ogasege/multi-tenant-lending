import { parseOrigin } from '../../../config/cell-origins';

/**
 * Lifecycle status of an institution, as projected into the directory. A slug can also be
 * held by a `PENDING` reservation while its registration is in flight; reservations are
 * never returned as entries (see `TenantDirectory.reserve`).
 */
export type DirectoryStatus = 'ACTIVE' | 'SUSPENDED';

export const DIRECTORY_STATUSES: readonly DirectoryStatus[] = ['ACTIVE', 'SUSPENDED'];

/**
 * One tenant in the global tenant directory (SPEC §4.1). A projection of the home cell's
 * Postgres (the source of truth), keyed by slug and replicated to every cell region.
 */
export interface DirectoryEntry {
  slug: string;
  institutionId: string;
  homeRegion: string;
  /** Public origin of the home cell, e.g. `https://af-south-1.api.example.com`. */
  apiBaseUrl: string;
  status: DirectoryStatus;
  /**
   * Monotonic per institution: microseconds since the epoch of the source change
   * (`institutions.updated_at` = the outbox event's `occurred_at`). Writes with a lower or
   * equal version are ignored, so redelivered or reordered events never regress state.
   */
  version: number;
  /** ISO-8601 time of the directory write. */
  updatedAt: string;
}

/** A cell (one deployment in one region) and its public API origin. */
export interface CellEndpoint {
  region: string;
  apiBaseUrl: string;
}

/** Same rule as the `institutions.slug` CHECK constraint. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 63 && SLUG.test(value);
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function isValidRegion(value: unknown): value is string {
  return typeof value === 'string' && REGION.test(value);
}

/**
 * Validates a cell API base URL and returns its normalised origin (no trailing slash), or
 * `undefined` when it is unsafe to send clients there. Only bare origins are accepted:
 * `https://` (plain `http://` only when `allowInsecure`, i.e. test/development — there is no
 * loopback exception, so production never redirects to http), no credentials, path, query
 * or fragment. Redirect targets must additionally match the configured trusted origin of
 * their region (`trustedCellOrigin`).
 */
export function parseApiBaseUrl(raw: unknown, allowInsecure: boolean): string | undefined {
  return parseOrigin(raw, allowInsecure);
}
