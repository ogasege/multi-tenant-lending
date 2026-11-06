import { Injectable } from '@nestjs/common';

import type { Tx } from '../../../common/database/database.tokens';
import type { ApplicationStatus, NewRow, Row, RowUpdate } from '../../../common/database/schema';
import { afterCursor, type CursorPosition, cursorTimestamp } from '../../../common/http/pagination';

export type ApplicationRow = Row<'loan_applications'>;
export type AssessmentRow = Row<'credit_assessments'>;
export type CustomerRow = Row<'customers'>;
export type ProductRow = Row<'loan_products'>;
export type VersionRow = Row<'loan_product_versions'>;

export interface InstitutionSettings {
  timezone: string;
  maxAprBps: number | null;
}

/**
 * Kysely persistence for applications, credit assessments and the reference data they are
 * validated against. Every method takes the caller's tenant-pinned transaction, so RLS scopes
 * each statement to that tenant and another tenant's id finds nothing (→ 404).
 */
@Injectable()
export class ApplicationsRepository {
  async institution(tx: Tx): Promise<InstitutionSettings> {
    const row = await tx
      .selectFrom('institutions')
      .select(['timezone', 'max_apr_bps'])
      .executeTakeFirstOrThrow();
    return { timezone: row.timezone, maxAprBps: row.max_apr_bps };
  }

  customerById(tx: Tx, id: string): Promise<CustomerRow | undefined> {
    return tx.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
  }

  customerByUserId(tx: Tx, userId: string): Promise<CustomerRow | undefined> {
    return tx.selectFrom('customers').selectAll().where('user_id', '=', userId).executeTakeFirst();
  }

  /** The product and its CURRENT version (the one new applications are made against). */
  async productWithCurrentVersion(
    tx: Tx,
    productId: string,
  ): Promise<{ product: ProductRow; version: VersionRow } | undefined> {
    const product = await tx
      .selectFrom('loan_products')
      .selectAll()
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) return undefined;
    const version = await tx
      .selectFrom('loan_product_versions')
      .selectAll()
      .where('product_id', '=', product.id)
      .where('version', '=', product.current_version)
      .executeTakeFirstOrThrow();
    return { product, version };
  }

  async versionWithProduct(
    tx: Tx,
    versionId: string,
  ): Promise<{ product: ProductRow; version: VersionRow }> {
    const version = await tx
      .selectFrom('loan_product_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow();
    const product = await tx
      .selectFrom('loan_products')
      .selectAll()
      .where('id', '=', version.product_id)
      .executeTakeFirstOrThrow();
    return { product, version };
  }

  /** Worst current DPD of the customer's active loans at this tenant (0 if none). */
  async maxActiveDpd(tx: Tx, customerId: string): Promise<number> {
    const row = await tx
      .selectFrom('loans')
      .select((eb) => eb.fn.max('days_past_due').as('dpd'))
      .where('customer_id', '=', customerId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row?.dpd ?? 0;
  }

  insert(tx: Tx, values: NewRow<'loan_applications'>): Promise<ApplicationRow> {
    return tx
      .insertInto('loan_applications')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * One application; `customerId` restricts it to that customer's own (object-level
   * authorisation). `forUpdate` locks the row for a state change.
   */
  find(
    tx: Tx,
    id: string,
    opts: { customerId?: string; forUpdate?: boolean } = {},
  ): Promise<ApplicationRow | undefined> {
    let q = tx.selectFrom('loan_applications').selectAll().where('id', '=', id);
    if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Newest first, keyset on (created_at, id). */
  list(
    tx: Tx,
    opts: {
      limit: number;
      after?: CursorPosition;
      status?: ApplicationStatus;
      customerId?: string;
    },
  ): Promise<(ApplicationRow & { cursor_ts: string })[]> {
    let q = tx
      .selectFrom('loan_applications')
      .selectAll()
      .select(cursorTimestamp().as('cursor_ts'))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.limit + 1);
    if (opts.after) q = q.where(afterCursor(opts.after));
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
    return q.execute();
  }

  update(tx: Tx, id: string, patch: RowUpdate<'loan_applications'>): Promise<ApplicationRow> {
    return tx
      .updateTable('loan_applications')
      .set((eb) => ({ ...patch, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertAssessment(tx: Tx, values: NewRow<'credit_assessments'>): Promise<AssessmentRow> {
    return tx
      .insertInto('credit_assessments')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  latestAssessment(tx: Tx, applicationId: string): Promise<AssessmentRow | undefined> {
    return tx
      .selectFrom('credit_assessments')
      .selectAll()
      .where('application_id', '=', applicationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** Id of the loan created when the application was approved, if any. */
  async loanIdOf(tx: Tx, applicationId: string): Promise<string | null> {
    const row = await tx
      .selectFrom('loans')
      .select('id')
      .where('application_id', '=', applicationId)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
