import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { Tx } from '../../../common/database/database.tokens';
import type {
  DpdBucket,
  LoanStatus,
  NewRow,
  Row,
  RowUpdate,
} from '../../../common/database/schema';
import { afterCursor, type CursorPosition, cursorTimestamp } from '../../../common/http/pagination';
import type { IsoDate } from '../domain';

export type LoanRow = Row<'loans'>;
export type InstalmentRow = Row<'loan_instalments'>;
export type RepaymentRow = Row<'repayments'>;

/**
 * Kysely persistence for loans, their instalments and repayments. Lock order is always
 * loan → instalments (SPEC §9): every money-moving path locks the loan row first, so two
 * transactions on the same loan serialise on it and can never deadlock on the instalments.
 */
@Injectable()
export class LoansRepository {
  insert(tx: Tx, values: NewRow<'loans'>): Promise<LoanRow> {
    return tx.insertInto('loans').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /**
   * One loan; `customerId` restricts it to that customer's own. `lock: 'wait'` is
   * `FOR UPDATE`; `lock: 'skip'` is `FOR UPDATE SKIP LOCKED` (batch jobs: a loan busy with a
   * repayment is left for the next run instead of blocking the batch).
   */
  find(
    tx: Tx,
    id: string,
    opts: { customerId?: string; lock?: 'wait' | 'skip' } = {},
  ): Promise<LoanRow | undefined> {
    let q = tx.selectFrom('loans').selectAll().where('id', '=', id);
    if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
    if (opts.lock === 'wait') q = q.forUpdate();
    if (opts.lock === 'skip') q = q.forUpdate().skipLocked();
    return q.executeTakeFirst();
  }

  findByApplication(
    tx: Tx,
    applicationId: string,
    opts: { lock?: 'skip' } = {},
  ): Promise<LoanRow | undefined> {
    let q = tx.selectFrom('loans').selectAll().where('application_id', '=', applicationId);
    if (opts.lock === 'skip') q = q.forUpdate().skipLocked();
    return q.executeTakeFirst();
  }

  list(
    tx: Tx,
    opts: {
      limit: number;
      after?: CursorPosition;
      status?: LoanStatus;
      dpdBucket?: DpdBucket;
      minDaysPastDue?: number;
      customerId?: string;
    },
  ): Promise<(LoanRow & { cursor_ts: string })[]> {
    let q = tx
      .selectFrom('loans')
      .selectAll()
      .select(cursorTimestamp().as('cursor_ts'))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.limit + 1);
    if (opts.after) q = q.where(afterCursor(opts.after));
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.dpdBucket) q = q.where('dpd_bucket', '=', opts.dpdBucket);
    if (opts.minDaysPastDue !== undefined) {
      q = q.where('days_past_due', '>=', opts.minDaysPastDue);
    }
    if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
    return q.execute();
  }

  update(tx: Tx, id: string, patch: RowUpdate<'loans'>): Promise<LoanRow> {
    return tx
      .updateTable('loans')
      .set((eb) => ({ ...patch, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Days past due and bucket only; unlike `update`, does not bump the row `version`. */
  async setDelinquency(tx: Tx, id: string, daysPastDue: number, bucket: DpdBucket): Promise<void> {
    await tx
      .updateTable('loans')
      .set({ days_past_due: daysPastDue, dpd_bucket: bucket })
      .where('id', '=', id)
      .execute();
  }

  /** Instalments in contractual order; `forUpdate` after the loan row is already locked. */
  instalments(
    tx: Tx,
    loanId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<InstalmentRow[]> {
    const q = tx
      .selectFrom('loan_instalments')
      .selectAll()
      .where('loan_id', '=', loanId)
      .orderBy('seq', 'asc');
    return (opts.forUpdate ? q.forUpdate() : q).execute();
  }

  /** Instalments of several loans in one query, grouped by loan id (list views). */
  async instalmentsByLoan(
    tx: Tx,
    loanIds: readonly string[],
  ): Promise<Map<string, InstalmentRow[]>> {
    const byLoan = new Map<string, InstalmentRow[]>(loanIds.map((id) => [id, []]));
    if (loanIds.length === 0) return byLoan;
    const rows = await tx
      .selectFrom('loan_instalments')
      .selectAll()
      .where('loan_id', 'in', loanIds)
      .orderBy('seq', 'asc')
      .execute();
    for (const row of rows) byLoan.get(row.loan_id)?.push(row);
    return byLoan;
  }

  async insertInstalments(tx: Tx, rows: NewRow<'loan_instalments'>[]): Promise<void> {
    await tx.insertInto('loan_instalments').values(rows).execute();
  }

  async updateInstalment(tx: Tx, id: string, patch: RowUpdate<'loan_instalments'>): Promise<void> {
    await tx.updateTable('loan_instalments').set(patch).where('id', '=', id).execute();
  }

  insertRepayment(tx: Tx, values: NewRow<'repayments'>): Promise<RepaymentRow> {
    return tx.insertInto('repayments').values(values).returningAll().executeTakeFirstOrThrow();
  }

  repayments(tx: Tx, loanId: string): Promise<RepaymentRow[]> {
    return tx
      .selectFrom('repayments')
      .selectAll()
      .where('loan_id', '=', loanId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  /** Value date of the loan's latest repayment (`undefined` = none yet). */
  async latestRepaymentValueDate(tx: Tx, loanId: string): Promise<IsoDate | undefined> {
    const row = await tx
      .selectFrom('repayments')
      .select('value_date')
      .where('loan_id', '=', loanId)
      .orderBy('value_date', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.value_date;
  }

  async externalReferenceExists(tx: Tx, externalReference: string): Promise<boolean> {
    const row = await tx
      .selectFrom('repayments')
      .select('id')
      .where('external_reference', '=', externalReference)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Ids of all ACTIVE loans of the tenant, oldest first (EOD work list). */
  async activeLoanIds(tx: Tx): Promise<string[]> {
    const rows = await tx
      .selectFrom('loans')
      .select('id')
      .where('status', '=', 'ACTIVE')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * Approved, still undisbursed applications whose approval has lapsed by the end of business
   * day `asOf` in the institution's time zone (`expires_at` < midnight starting `asOf + 1`)
   * AND by `now` (`expires_at <= now`): EOD run during day `asOf` (or for a future date)
   * never expires an approval that is still valid for the rest of the day.
   */
  async lapsedApprovalIds(tx: Tx, asOf: IsoDate, timeZone: string, now: Date): Promise<string[]> {
    const rows = await tx
      .selectFrom('loan_applications as a')
      .innerJoin('loans as l', 'l.application_id', 'a.id')
      .select('a.id')
      .where('a.status', '=', 'APPROVED')
      .where('l.status', '=', 'PENDING_DISBURSEMENT')
      .where(
        'a.expires_at',
        '<',
        sql<Date>`((${asOf}::date + 1)::timestamp AT TIME ZONE ${timeZone})`,
      )
      .where('a.expires_at', '<=', now)
      .orderBy('a.expires_at', 'asc')
      .execute();
    return rows.map((r) => r.id);
  }
}
