import { Injectable } from '@nestjs/common';

import type { Tx } from '../../../common/database/database.tokens';
import type { Row } from '../../../common/database/schema';
import { afterCursor, type CursorPosition, cursorTimestamp } from '../../../common/http/pagination';
import { assertCurrency } from '../../../common/money/currency';
import type { ProductTerms } from '../domain/product-terms';

export type ProductRow = Row<'loan_products'>;
export type VersionRow = Row<'loan_product_versions'>;
export type ProductStatus = ProductRow['status'];

export interface InstitutionPolicy {
  supportedCurrencies: string[];
  maxAprBps: number | null;
  timezone: string;
}

/** Product version row → domain terms. */
export function toTerms(row: VersionRow): ProductTerms {
  return {
    currency: assertCurrency(row.currency),
    minPrincipal: row.min_principal,
    maxPrincipal: row.max_principal,
    minTerm: row.min_term,
    maxTerm: row.max_term,
    repaymentFrequency: row.repayment_frequency,
    interestMethod: row.interest_method,
    annualInterestRateBps: row.annual_interest_rate_bps,
    dayCount: row.day_count,
    originationFee: {
      type: row.origination_fee_type,
      value: row.origination_fee_value,
      treatment: row.origination_fee_treatment,
    },
    lateFee: {
      type: row.late_fee_type,
      value: row.late_fee_value,
      graceDays: row.late_fee_grace_days,
    },
    maxDtiBps: row.max_dti_bps,
    minCreditScore: row.min_credit_score,
    applicationExpiryDays: row.application_expiry_days,
    disbursementMode: row.disbursement_mode,
  };
}

/**
 * Kysely persistence for loan products and their immutable versions. Every method takes the
 * caller's tenant-pinned transaction: RLS scopes all reads and writes to that tenant, so an
 * id from another tenant simply finds nothing (→ 404).
 */
@Injectable()
export class LoanProductsRepository {
  async institutionPolicy(tx: Tx): Promise<InstitutionPolicy | undefined> {
    const row = await tx
      .selectFrom('institutions')
      .select(['supported_currencies', 'max_apr_bps', 'timezone'])
      .executeTakeFirst();
    return (
      row && {
        supportedCurrencies: row.supported_currencies,
        maxAprBps: row.max_apr_bps,
        timezone: row.timezone,
      }
    );
  }

  insertProduct(
    tx: Tx,
    values: { tenantId: string; code: string; name: string; description: string | null },
  ): Promise<ProductRow> {
    return tx
      .insertInto('loan_products')
      .values({
        tenant_id: values.tenantId,
        code: values.code,
        name: values.name,
        description: values.description,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertVersion(
    tx: Tx,
    values: {
      tenantId: string;
      productId: string;
      version: number;
      terms: ProductTerms;
      createdBy: string;
    },
  ): Promise<VersionRow> {
    const t = values.terms;
    return tx
      .insertInto('loan_product_versions')
      .values({
        tenant_id: values.tenantId,
        product_id: values.productId,
        version: values.version,
        currency: t.currency,
        min_principal: t.minPrincipal,
        max_principal: t.maxPrincipal,
        min_term: t.minTerm,
        max_term: t.maxTerm,
        repayment_frequency: t.repaymentFrequency,
        interest_method: t.interestMethod,
        annual_interest_rate_bps: t.annualInterestRateBps,
        day_count: t.dayCount,
        origination_fee_type: t.originationFee.type,
        origination_fee_value: t.originationFee.value,
        origination_fee_treatment: t.originationFee.treatment,
        late_fee_type: t.lateFee.type,
        late_fee_value: t.lateFee.value,
        late_fee_grace_days: t.lateFee.graceDays,
        max_dti_bps: t.maxDtiBps,
        min_credit_score: t.minCreditScore,
        application_expiry_days: t.applicationExpiryDays,
        disbursement_mode: t.disbursementMode,
        created_by: values.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findProduct(
    tx: Tx,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ProductRow | undefined> {
    const query = tx.selectFrom('loan_products').selectAll().where('id', '=', id);
    return (opts.forUpdate ? query.forUpdate() : query).executeTakeFirst();
  }

  findVersion(tx: Tx, productId: string, version: number): Promise<VersionRow | undefined> {
    return tx
      .selectFrom('loan_product_versions')
      .selectAll()
      .where('product_id', '=', productId)
      .where('version', '=', version)
      .executeTakeFirst();
  }

  listVersions(
    tx: Tx,
    productId: string,
  ): Promise<Pick<VersionRow, 'id' | 'version' | 'created_at' | 'created_by'>[]> {
    return tx
      .selectFrom('loan_product_versions')
      .select(['id', 'version', 'created_at', 'created_by'])
      .where('product_id', '=', productId)
      .orderBy('version', 'desc')
      .execute();
  }

  /** Newest first, keyset-paginated on the raw (created_at, id) (see `pagination.ts`). */
  async listProducts(
    tx: Tx,
    opts: { limit: number; after?: CursorPosition; status?: ProductStatus },
  ): Promise<{ product: ProductRow; current: VersionRow; cursorTs: string }[]> {
    let query = tx
      .selectFrom('loan_products as p')
      .innerJoin('loan_product_versions as v', (join) =>
        join.onRef('v.product_id', '=', 'p.id').onRef('v.version', '=', 'p.current_version'),
      )
      .selectAll('v')
      .select([
        'p.id as p_id',
        'p.tenant_id as p_tenant_id',
        'p.code as p_code',
        'p.name as p_name',
        'p.description as p_description',
        'p.status as p_status',
        'p.current_version as p_current_version',
        'p.created_at as p_created_at',
        'p.updated_at as p_updated_at',
      ])
      .select(cursorTimestamp('p.created_at').as('p_cursor_ts'));
    if (opts.status) query = query.where('p.status', '=', opts.status);
    if (opts.after) query = query.where(afterCursor(opts.after, 'p.created_at', 'p.id'));
    const rows = await query
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(opts.limit + 1)
      .execute();
    return rows.map(
      ({
        p_id,
        p_tenant_id,
        p_code,
        p_name,
        p_description,
        p_status,
        p_current_version,
        p_created_at,
        p_updated_at,
        p_cursor_ts,
        ...current
      }) => ({
        cursorTs: p_cursor_ts,
        product: {
          id: p_id,
          tenant_id: p_tenant_id,
          code: p_code,
          name: p_name,
          description: p_description,
          status: p_status,
          current_version: p_current_version,
          created_at: p_created_at,
          updated_at: p_updated_at,
        },
        current,
      }),
    );
  }

  /** Compare-and-set bump of `current_version`; `undefined` when it already moved on. */
  setCurrentVersion(
    tx: Tx,
    id: string,
    expectedVersion: number,
    next: number,
  ): Promise<ProductRow | undefined> {
    return tx
      .updateTable('loan_products')
      .set({ current_version: next })
      .where('id', '=', id)
      .where('current_version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
  }

  setStatus(tx: Tx, id: string, status: ProductStatus): Promise<ProductRow> {
    return tx
      .updateTable('loan_products')
      .set({ status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
