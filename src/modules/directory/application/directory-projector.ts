import {
  type CellEndpoint,
  DIRECTORY_STATUSES,
  type DirectoryEntry,
  type DirectoryStatus,
  isValidSlug,
} from '../domain/directory-entry';

import type { TenantDirectory } from './tenant-directory.port';

/** Outbox event types the directory consumes. */
export const DIRECTORY_EVENT_TYPES = [
  'institution.registered',
  'institution.status_changed',
] as const;

/**
 * An institution outbox event as handed over by the worker.
 *
 * `version` must be monotonic per institution; use the event's `occurred_at` in microseconds
 * since the epoch (`(extract(epoch FROM occurred_at) * 1e6)::bigint`), which equals the
 * `institutions.updated_at` written by the same transaction. A payload `version` (number)
 * takes precedence.
 *
 * Payload fields read: `institutionId` (required), `slug`, `homeRegion`, and the new status
 * as `status` or `to` (`institution.status_changed`). A missing slug is looked up by id.
 */
export interface InstitutionEvent {
  type: string;
  version: number;
  payload: Readonly<Record<string, unknown>>;
}

/**
 * Outcome of projecting one event. `stale` carries the slug and the row that blocked the
 * write (unvalidated, see `UpsertResult`), so a conflict check needs no further read.
 */
export type ProjectionResult =
  | { result: 'applied'; slug: string }
  | { result: 'stale'; slug: string; current?: DirectoryEntry }
  | { result: 'ignored' };

/** Source-of-truth lookup for events whose payload does not carry the slug. */
export interface InstitutionLookup {
  slugOf(institutionId: string): Promise<string | undefined>;
}

export const INSTITUTION_LOOKUP = Symbol('INSTITUTION_LOOKUP');

/** Called after a write was applied, e.g. to drop this cell's cached directory entry. */
export type ProjectionListener = (slug: string) => Promise<void>;

/**
 * Projects this cell's institution outbox events into the global tenant directory.
 *
 * The worker is its consumer: for every `institution.registered` / `institution.status_changed`
 * outbox row it calls `project()` (and may periodically call `projectPendingInstitutions()`
 * to reconcile). Writes are conditional on `version`, so the projection is idempotent and
 * order-insensitive: redelivered events are no-ops and an older event never overwrites a
 * newer state. A cell only projects tenants homed in its own region, pointing at its own
 * `CELL_API_BASE_URL`.
 */
export class DirectoryProjector {
  private cellRegistered = false;

  constructor(
    private readonly directory: TenantDirectory,
    private readonly cell: CellEndpoint,
    private readonly institutions: InstitutionLookup,
    private readonly onApplied?: ProjectionListener,
  ) {}

  async project(event: InstitutionEvent): Promise<ProjectionResult> {
    if (!(DIRECTORY_EVENT_TYPES as readonly string[]).includes(event.type)) {
      return { result: 'ignored' };
    }
    const { payload } = event;

    const institutionId = payload.institutionId;
    if (typeof institutionId !== 'string' || !institutionId) {
      throw new Error(`${event.type} event without institutionId`);
    }
    const version = typeof payload.version === 'number' ? payload.version : event.version;
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`${event.type} event for ${institutionId} has no valid version`);
    }

    const status = statusOf(event.type, payload);
    const homeRegion = payload.homeRegion ?? this.cell.region;
    if (homeRegion !== this.cell.region) {
      // Data residency: a cell stores (and therefore projects) only its own region's tenants.
      throw new Error(
        `Institution ${institutionId} is homed in ${JSON.stringify(homeRegion)}, not ${this.cell.region}`,
      );
    }
    const slug = isValidSlug(payload.slug)
      ? payload.slug
      : await this.institutions.slugOf(institutionId);
    if (!slug) return { result: 'ignored' };

    await this.ensureCellRegistered();
    const outcome = await this.directory.upsert({
      slug,
      institutionId,
      homeRegion,
      apiBaseUrl: this.cell.apiBaseUrl,
      status,
      version,
      updatedAt: new Date().toISOString(),
    });
    if (outcome.result === 'applied') {
      await this.onApplied?.(slug);
      return { result: 'applied', slug };
    }
    return outcome.current
      ? { result: 'stale', slug, current: outcome.current }
      : { result: 'stale', slug };
  }

  /** The cell record lets other cells resolve this region's base URL (421 responses). */
  private async ensureCellRegistered(): Promise<void> {
    if (this.cellRegistered) return;
    await this.directory.putCell(this.cell);
    this.cellRegistered = true;
  }
}

function statusOf(type: string, payload: Readonly<Record<string, unknown>>): DirectoryStatus {
  const raw =
    payload.status ?? (type === 'institution.registered' ? 'ACTIVE' : (payload.to ?? undefined));
  if (!(DIRECTORY_STATUSES as readonly unknown[]).includes(raw)) {
    throw new Error(`${type} event has an invalid status: ${JSON.stringify(raw)}`);
  }
  return raw as DirectoryStatus;
}
