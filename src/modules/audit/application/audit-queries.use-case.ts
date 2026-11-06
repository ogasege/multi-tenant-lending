import { Injectable } from '@nestjs/common';

import { type ChainVerification, verifyAuditChain } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import type { ActorType } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { DEFAULT_PAGE_LIMIT, type Page } from '../../../common/http/pagination';

export interface AuditLogView {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: string;
  prevHash: string;
  hash: string;
}

export interface AuditLogQuery {
  limit?: number;
  cursor?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
}

/** Keyset cursor over the identity column: base64url of the last id seen. */
export function encodeIdCursor(id: bigint): string {
  return Buffer.from(id.toString()).toString('base64url');
}

/** Inverse of {@link encodeIdCursor}; `undefined` for anything that is not a positive id. */
export function decodeIdCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[1-9]\d{0,18}$/.test(raw) ? BigInt(raw) : undefined;
}

/**
 * The caller's audit trail, newest first. Keyset pagination on the monotonically increasing
 * `id` (the chain order), filtered by entity and action. RLS confines it to the tenant.
 */
@Injectable()
export class ListAuditLogs {
  constructor(private readonly runner: TransactionRunner) {}

  execute(query: AuditLogQuery): Promise<Page<AuditLogView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const after = decodeIdCursor(query.cursor);
    return this.runner.run(async (tx) => {
      let q = tx
        .selectFrom('audit_log')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (after !== undefined) q = q.where('id', '<', after);
      if (query.entityType) q = q.where('entity_type', '=', query.entityType);
      if (query.entityId) q = q.where('entity_id', '=', query.entityId);
      if (query.action) q = q.where('action', '=', query.action);
      const rows = await q.execute();
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((r) => ({
          id: r.id.toString(),
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          before: r.before_state,
          after: r.after_state,
          requestId: r.request_id,
          ipAddress: r.ip_address,
          userAgent: r.user_agent,
          occurredAt: r.occurred_at.toISOString(),
          prevHash: r.prev_hash,
          hash: r.hash,
        })),
        nextCursor: rows.length > limit && last ? encodeIdCursor(last.id) : null,
      };
    });
  }
}

/** Recomputes the caller's whole hash chain from genesis (SPEC §9). */
@Injectable()
export class VerifyAuditChain {
  constructor(private readonly runner: TransactionRunner) {}

  execute(principal: TenantUser): Promise<ChainVerification> {
    return this.runner.run((tx) => verifyAuditChain(tx, principal.tenantId));
  }
}
