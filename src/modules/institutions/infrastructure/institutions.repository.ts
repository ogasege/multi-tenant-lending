import { Injectable } from '@nestjs/common';

import type { Tx } from '../../../common/database/database.tokens';
import type { Row } from '../../../common/database/schema';

export type InstitutionRow = Row<'institutions'>;
export type BrandingRow = Row<'institution_branding'>;

/** Tenant-editable branding fields (everything except the key and bookkeeping columns). */
export interface BrandingChanges {
  display_name: string;
  primary_color: string;
  secondary_color: string;
  support_email: string | null;
  support_phone: string | null;
  website_url: string | null;
  locale: string;
  logo_object_key: string | null;
}

/**
 * Persistence for the institution profile and branding. Every method runs inside a
 * tenant-pinned transaction, so RLS limits it to the caller's own rows (and
 * `institutions` is SELECT-only for tenants).
 */
@Injectable()
export class InstitutionsRepository {
  findInstitution(tx: Tx): Promise<InstitutionRow | undefined> {
    // RLS (`tenant_read_own`) returns only the pinned tenant's row.
    return tx.selectFrom('institutions').selectAll().executeTakeFirst();
  }

  findBranding(tx: Tx, opts: { forUpdate?: boolean } = {}): Promise<BrandingRow | undefined> {
    const query = tx.selectFrom('institution_branding').selectAll();
    return (opts.forUpdate ? query.forUpdate() : query).executeTakeFirst();
  }

  /**
   * Compare-and-set update: only succeeds while the stored version still equals
   * `expectedVersion`, and bumps it. Returns `undefined` when the version moved on.
   */
  updateBranding(
    tx: Tx,
    tenantId: string,
    expectedVersion: number,
    changes: BrandingChanges,
  ): Promise<BrandingRow | undefined> {
    return tx
      .updateTable('institution_branding')
      .set((eb) => ({ ...changes, version: eb('version', '+', 1) }))
      .where('tenant_id', '=', tenantId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
  }
}
