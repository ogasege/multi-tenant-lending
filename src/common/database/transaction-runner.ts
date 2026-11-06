import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';
import { UnauthenticatedError } from '../errors/app-error';

import { APP_DB, type Db, type Tx } from './database.tokens';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

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
 * the idempotency record are all written inside this same transaction (all-or-nothing).
 */
@Injectable()
export class TransactionRunner {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  /** Run in the tenant of the current request (taken from the verified JWT). */
  run<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    if (!tenantId) throw new UnauthenticatedError();
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
   * Callers must already have verified an `aud=platform` access token.
   */
  asPlatformAdmin<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: TxOptions & { tenantId?: string } = {},
  ): Promise<T> {
    return this.execute(opts, async (tx) => {
      await sql`SELECT set_config('app.platform_admin', 'on', true)`.execute(tx);
      if (opts.tenantId) await setTenant(tx, opts.tenantId);
      return fn(tx);
    });
  }

  /** Unscoped transaction: only for tables without RLS (platform admin credentials). */
  runUnscoped<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.execute(opts, fn);
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
