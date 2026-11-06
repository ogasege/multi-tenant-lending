import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';
import { canonicalJson, sha256Hex } from '../crypto/crypto';
import type { Tx } from '../database/database.tokens';
import type { ActorType } from '../database/schema';

export const GENESIS_HASH = 'GENESIS';

export interface AuditEntry {
  action: string; // e.g. 'loan.disbursed'
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Defaults to the tenant of the current request. */
  tenantId?: string;
  /**
   * Defaults to the request's principal (or SYSTEM). Set it on public routes where the
   * actor is known but not yet authenticated, e.g. the user signing in.
   */
  actor?: { type: ActorType; id: string | null };
}

/**
 * Field names are normalised (lower-case, no `_`/`-`) before matching, so `nationalId`,
 * `national_id` and `NATIONAL-ID` are treated alike. Audit rows are immutable, so anything
 * sensitive must be removed BEFORE it is written — it can never be purged afterwards.
 */
const REDACTED = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretciphertext',
  'token',
  'refreshtoken',
  'accesstoken',
  'tokenhash',
  'hmac',
  'nationalid',
  'nationalidhmac',
  'bvn',
  'nin',
  'dateofbirth',
]);
const MASKED = new Set(['payeeaccount', 'accountnumber', 'email', 'phone']);

const normalise = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');

/**
 * Removes secrets and personal identifiers, masks contact/account details, and turns bigints
 * into strings so the stored JSON round-trips exactly (needed for re-hashing).
 */
export function sanitiseForAudit(value: unknown, key = ''): unknown {
  const k = normalise(key);
  if (REDACTED.has(k)) return '[REDACTED]';
  if (typeof value === 'string' && MASKED.has(k)) return `****${value.slice(-4)}`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  // Array elements inherit the parent key, so `accountNumber: ['…']` is masked too.
  if (Array.isArray(value)) return value.map((v) => sanitiseForAudit(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, v]) => [childKey, sanitiseForAudit(v, childKey)]),
    );
  }
  return value;
}

interface HashableEntry {
  tenantId: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  requestId: string | null;
  /** Client context is hashed too, so it cannot be altered without breaking the chain. */
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: string;
}

export function hashEntry(prevHash: string, entry: HashableEntry): string {
  return sha256Hex(`${prevHash}|${canonicalJson(entry)}`);
}

/**
 * Appends to the tenant's tamper-evident audit chain INSIDE the caller's transaction, so a
 * business change and its audit record commit or roll back together.
 *
 * Chain: hash = sha256(prev_hash | canonical(entry)); the entry includes the client IP and
 * user agent, so the request context is as tamper-evident as the change itself. A per-tenant advisory lock serialises
 * appends so two concurrent transactions can never fork the chain.
 */
@Injectable()
export class AuditWriter {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const ctx = this.cls.isActive() ? this.cls.get() : undefined;
    const tenantId = entry.tenantId ?? ctx?.tenantId;
    if (!tenantId) throw new Error('Audit entry requires a tenant');

    const principal = ctx?.principal;
    const hashable: HashableEntry = {
      tenantId,
      actorType: entry.actor?.type ?? principal?.kind ?? 'SYSTEM',
      actorId: entry.actor ? entry.actor.id : (principal?.id ?? null),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: sanitiseForAudit(entry.before ?? null),
      after: sanitiseForAudit(entry.after ?? null),
      requestId: ctx?.requestId ?? null,
      ipAddress: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      occurredAt: new Date().toISOString(),
    };

    await sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`.execute(tx);
    const last = await tx
      .selectFrom('audit_log')
      .select('hash')
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const prevHash = last?.hash ?? GENESIS_HASH;

    await tx
      .insertInto('audit_log')
      .values({
        tenant_id: tenantId,
        actor_type: hashable.actorType,
        actor_id: hashable.actorId,
        action: hashable.action,
        entity_type: hashable.entityType,
        entity_id: hashable.entityId,
        before_state: JSON.stringify(hashable.before),
        after_state: JSON.stringify(hashable.after),
        request_id: hashable.requestId,
        ip_address: hashable.ipAddress,
        user_agent: hashable.userAgent,
        occurred_at: new Date(hashable.occurredAt),
        prev_hash: prevHash,
        hash: hashEntry(prevHash, hashable),
      })
      .execute();
  }
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  firstBrokenEntryId?: string;
}

/** Recomputes the tenant's chain from genesis; any edited, removed or re-ordered row breaks it. */
export async function verifyAuditChain(tx: Tx, tenantId: string): Promise<ChainVerification> {
  const rows = await tx
    .selectFrom('audit_log')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('id', 'asc')
    .execute();

  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const expected = hashEntry(prevHash, {
      tenantId: row.tenant_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before_state,
      after: row.after_state,
      requestId: row.request_id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      occurredAt: row.occurred_at.toISOString(),
    });
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { valid: false, entriesChecked: rows.length, firstBrokenEntryId: String(row.id) };
    }
    prevHash = row.hash;
  }
  return { valid: true, entriesChecked: rows.length };
}
