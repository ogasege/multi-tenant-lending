import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../../../common/context/request-context';
import type { Tx } from '../../../common/database/database.tokens';
import { assertBalanced, type JournalEntryDraft } from '../domain/journal';

export interface PostedEntry {
  journalEntryId: string;
  /** False when an entry with the same `idempotencyRef` already existed (nothing posted). */
  created: boolean;
}

/**
 * The only writer of `journal_entries` / `postings`. Runs inside the caller's transaction so
 * the business change and its accounting commit together.
 *
 * Dedupe is business-level, independent of HTTP idempotency: `(tenant_id, idempotency_ref)` is
 * unique, the insert is `ON CONFLICT DO NOTHING`, and a repeat returns the existing entry
 * without posting again. The tenant comes from the transaction's `app.tenant_id`
 * (`app_current_tenant()`), so an entry can never be written into another tenant's books.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  async post(tx: Tx, entry: JournalEntryDraft): Promise<PostedEntry> {
    assertBalanced(entry.lines);

    const codes = [...new Set(entry.lines.map((l) => l.account))];
    const accounts = await tx
      .selectFrom('ledger_accounts')
      .select(['id', 'code'])
      .where('currency', '=', entry.currency)
      .where('code', 'in', codes)
      .execute();
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));
    const missing = codes.filter((c) => !accountId.has(c));
    if (missing.length > 0) {
      // Chart of accounts is created at registration: a gap is a configuration bug.
      throw new Error(`Ledger accounts ${missing.join(', ')} missing for ${entry.currency}`);
    }

    const principal = this.cls.isActive() ? this.cls.get('principal') : undefined;
    const inserted = await tx
      .insertInto('journal_entries')
      .values({
        tenant_id: sql<string>`app_current_tenant()`,
        kind: entry.kind,
        loan_id: entry.loanId,
        currency: entry.currency,
        description: entry.description,
        effective_date: entry.effectiveDate,
        idempotency_ref: entry.idempotencyRef,
        reverses_entry_id: entry.reversesEntryId ?? null,
        created_by: principal?.id ?? null,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_ref']).doNothing())
      .returning(['id', 'tenant_id'])
      .executeTakeFirst();

    if (!inserted) {
      const existingId = await this.entryIdByRef(tx, entry.idempotencyRef);
      if (!existingId) throw new Error(`Journal entry ${entry.idempotencyRef} not found`);
      return { journalEntryId: existingId, created: false };
    }

    await tx
      .insertInto('postings')
      .values(
        entry.lines.map((line) => ({
          tenant_id: inserted.tenant_id,
          journal_entry_id: inserted.id,
          account_id: accountId.get(line.account) ?? '',
          direction: line.direction,
          amount: line.amount,
          currency: entry.currency,
        })),
      )
      .execute();
    return { journalEntryId: inserted.id, created: true };
  }

  /** Id of the tenant's entry posted under `idempotencyRef`, if any. */
  async entryIdByRef(tx: Tx, idempotencyRef: string): Promise<string | undefined> {
    const row = await tx
      .selectFrom('journal_entries')
      .select('id')
      .where('idempotency_ref', '=', idempotencyRef)
      .executeTakeFirst();
    return row?.id;
  }
}
