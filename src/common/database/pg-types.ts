import pg from 'pg';

/**
 * Global pg type parsing. Must run before the first query. Idempotent.
 *
 * - BIGINT  -> JS `bigint`: money is stored in minor units and must never pass through a JS
 *   `number` (precision is lost above 2^53).
 * - DATE    -> `'YYYY-MM-DD'` string: business dates (due dates, value dates) have no time
 *   zone; turning them into `Date` objects would shift them by the server's UTC offset.
 */
export function configurePgTypes(): void {
  pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => BigInt(v));
  pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
}
