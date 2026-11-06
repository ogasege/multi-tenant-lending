import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

import { APP_DB, type Db, type Tx } from './database.tokens';

// REPEATABLE READ is deliberately not offered: its snapshot predates the audit chain's
// advisory lock and could fork the hash chain. SERIALIZABLE aborts instead (and is retried).
export type IsolationLevel = 'read committed' | 'serializable';

export interface TxOptions {
  isolation?: IsolationLevel;
  /** Retry on serialization failures / deadlocks (safe: the whole tx is rolled back). */
  maxAttempts?: number;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * The ONLY way application code touches the database.
 *
 * Every unit of work is one transaction that first pins the tenant with
 * `set_config('app.tenant_id', $1, true)` — `true` makes it transaction-local, so a pooled
 * connection can never leak one tenant's context into the next request. Postgres RLS policies
 * then filter every statement. Business rows, ledger postings, audit entries, outbox events and
 * (for idempotent routes) the stored response are all written in one transaction.
 */
@Injectable()
export class TransactionRunner {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  /**
   * Run in the tenant of the current request (taken from the verified JWT). Joins the
   * request's ambient transaction when an idempotent route opened one.
   */
  run<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    if (!tenantId) throw new UnauthenticatedError();
    const ambient = this.cls.get('ambientTx');
    if (ambient) return fn(ambient);
    return this.runForTenant(tenantId, fn, opts);
  }

  /**
   * Run in an explicit tenant. Used by public routes after resolving an institution slug and
   * by platform registration of a new institution. Never pass a client-supplied id here.
   */
  runForTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.execute(opts, async (tx) => {
      await setTenant(tx, tenantId);
      return fn(tx);
    });
  }

  /**
   * Platform-admin scope: enables the single `platform_admin_all` policy on `institutions`
   * (list / suspend). Optionally also pins a tenant, e.g. while registering a new institution.
   * Inside a request it requires a platform-admin principal (defence in depth: a tenant use case
   * can never widen its scope by mistake); outside a request (CLI, tests) it is unrestricted.
   */
  asPlatformAdmin<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: TxOptions & { tenantId?: string } = {},
  ): Promise<T> {
    if (this.cls.isActive() && this.cls.get('principal')?.kind !== 'PLATFORM_ADMIN') {
      return Promise.reject(new ForbiddenError());
    }
    return this.execute(opts, async (tx) => {
      await sql`SELECT set_config('app.platform_admin', 'on', true)`.execute(tx);
      if (opts.tenantId) await setTenant(tx, opts.tenantId);
      return fn(tx);
    });
  }

  /**
   * Platform authentication scope: the only context in which platform admin credentials and
   * refresh tokens are visible (`platform_auth_only` policies). Used by the platform auth
   * service for login/refresh, before any token exists.
   */
  asPlatformAuth<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.execute(opts, async (tx) => {
      await sql`SELECT set_config('app.platform_auth', 'on', true)`.execute(tx);
      return fn(tx);
    });
  }

  /**
   * Whether `slug` names an institution stored in THIS cell, via the SECURITY DEFINER function
   * `resolve_institution` (it reveals only id + status). No tenant is pinned, so every
   * RLS-protected table reads as empty inside this transaction. Used by cell routing before
   * any tenant context exists.
   */
  async resolveInstitution(
    slug: string,
  ): Promise<{ id: string; status: 'ACTIVE' | 'SUSPENDED' } | undefined> {
    const { rows } = await this.execute({}, (tx) =>
      sql<{
        id: string;
        status: 'ACTIVE' | 'SUSPENDED';
      }>`SELECT id, status FROM resolve_institution(${slug})`.execute(tx),
    );
    return rows[0];
  }

  /** Readiness probe: a trivial round-trip on the application pool. */
  async ping(): Promise<void> {
    await sql`SELECT 1`.execute(this.db);
  }

  private async execute<T>(opts: TxOptions, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const isolation = opts.isolation ?? 'read committed';
    const maxAttempts = opts.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction().setIsolationLevel(isolation).execute(fn);
      } catch (err) {
        if (attempt >= maxAttempts || !isRetryable(err)) throw err;
        // Jittered backoff before retrying the whole unit of work.
        await sleep(20 * attempt + Math.floor(Math.random() * 30));
      }
    }
  }
}

/** `true` = transaction-local: the setting dies with the transaction, never the connection. */
async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
}

function isRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    RETRYABLE_SQLSTATES.has(err.code)
  );
}
