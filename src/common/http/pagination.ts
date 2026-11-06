import type { Type as Class } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { type RawBuilder, sql } from 'kysely';

export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Cursor (keyset) pagination: stable under concurrent inserts and O(1) per page, unlike
 * OFFSET. The cursor is an opaque base64url of the last row's (created_at, id).
 * The hard cap of 100 items bounds resource consumption (OWASP API4).
 *
 * Keyset (current, "v2"): order by the RAW `created_at DESC, id DESC` (served by the V4
 * `(tenant_id, created_at DESC, id DESC)` indexes) and carry `created_at` at FULL microsecond
 * precision in the cursor, rendered by Postgres itself ({@link cursorTimestamp}), so no
 * precision is lost in a JS `Date`:
 *
 * ```ts
 * tx.selectFrom('users').selectAll().select(cursorTimestamp().as('cursor_ts'))
 *   .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1)
 *   .where(afterCursor(after))            // when a cursor was given
 * toPage(rows, limit, map)                // rows carry `cursor_ts`
 * ```
 *
 * Every list selects `cursor_ts`. A legacy millisecond cursor issued before v2 is still
 * accepted: {@link afterCursor} compares it against `created_at` truncated to milliseconds.
 */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Swagger model of a page of `item`: `class UserPageDto extends PageDto(UserDto) {}`. */
export function PageDto<T>(item: Class<T>): Class<Page<T>> {
  class PageOf implements Page<T> {
    @ApiProperty({ type: [item] }) items!: T[];
    @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  }
  return PageOf;
}

export interface CursorPosition {
  /** ISO-8601 UTC instant: microseconds for `us`, milliseconds for legacy `ms` cursors. */
  createdAt: string;
  /** Row id (always a UUID). */
  id: string;
  precision: 'us' | 'ms';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const V2 = 'v2';

export function encodeCursor(pos: CursorPosition): string {
  const raw =
    pos.precision === 'us' ? `${V2}|${pos.createdAt}|${pos.id}` : `${pos.createdAt}|${pos.id}`;
  return Buffer.from(raw).toString('base64url');
}

/**
 * Parses a cursor. Anything malformed — including an id that is not a UUID or a timestamp
 * Postgres would have to guess at — is treated as "first page" (`undefined`), never passed
 * into SQL.
 */
export function decodeCursor(cursor: string | undefined): CursorPosition | undefined {
  if (!cursor) return undefined;
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [first, second, third] = parts;
  if (parts.length === 3 && first === V2 && second && third) {
    if (!ISO_US.test(second) || !UUID.test(third) || !isRealInstant(second)) return undefined;
    return { createdAt: second, id: third.toLowerCase(), precision: 'us' };
  }
  if (parts.length === 2 && first && second) {
    if (!ISO_MS.test(first) || !UUID.test(second) || !isRealInstant(first)) return undefined;
    return { createdAt: first, id: second.toLowerCase(), precision: 'ms' };
  }
  return undefined;
}

function isRealInstant(iso: string): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === iso.slice(0, 19);
}

/**
 * `created_at` rendered by Postgres as an ISO-8601 UTC string with all six fractional
 * digits; select it `AS cursor_ts` so {@link toPage} can build an exact cursor.
 */
export function cursorTimestamp(column = 'created_at'): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Builds a page from `limit + 1` fetched rows (the extra row only signals "has more"). */
export function toPage<R extends { created_at: Date; id: string; cursor_ts?: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    nextCursor = last.cursor_ts
      ? encodeCursor({ createdAt: last.cursor_ts, id: last.id, precision: 'us' })
      : encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id, precision: 'ms' });
  }
  return { items: items.map(map), nextCursor };
}

/**
 * Rows strictly after `cursor` in (created_at desc, id desc) order. A microsecond cursor
 * compares the RAW column (row-value comparison, index-friendly with the V4 indexes); a
 * legacy millisecond cursor compares `created_at` truncated to milliseconds.
 */
export function afterCursor(
  cursor: CursorPosition,
  createdAtColumn = 'created_at',
  idColumn = 'id',
): RawBuilder<boolean> {
  const id = sql`${cursor.id}::uuid`;
  const at = sql`${cursor.createdAt}::timestamptz`;
  return cursor.precision === 'us'
    ? sql<boolean>`(${sql.ref(createdAtColumn)}, ${sql.ref(idColumn)}) < (${at}, ${id})`
    : sql<boolean>`(date_trunc('milliseconds', ${sql.ref(createdAtColumn)}), ${sql.ref(idColumn)}) < (${at}, ${id})`;
}
