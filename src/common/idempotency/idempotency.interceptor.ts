import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';
import { from, lastValueFrom, type Observable } from 'rxjs';

import type { RequestContextStore } from '../context/request-context';
import { canonicalJson, sha256Hex } from '../crypto/crypto';
import type { Tx } from '../database/database.tokens';
import { TransactionRunner } from '../database/transaction-runner';
import { BusinessRuleError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

export const IDEMPOTENT_KEY = 'idempotent';
/** Marks a route as requiring an `Idempotency-Key` header (money-moving operations). */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,255}$/;

interface Attempt {
  tenantId: string;
  principalId: string;
  key: string;
  fingerprint: string;
  method: string;
  path: string;
}

/**
 * Idempotency-Key semantics (Stripe; IETF draft-ietf-httpapi-idempotency-key-header), made
 * atomic with the business write:
 *
 *  One database transaction wraps the whole request. It reserves (tenant, principal, key),
 *  runs the handler — whose TransactionRunner.run() JOINS this transaction — and stores the
 *  response before COMMIT. So either the money movement AND its stored response commit
 *  together, or neither does; there is no window in which a retry can execute twice.
 *
 *  - same key + same fingerprint, already committed → replay stored status/body with
 *    `Idempotent-Replayed: true`;
 *  - same key while the first request is still running → the INSERT waits on Postgres's
 *    unique-index lock, then replays the committed result (or proceeds if the first rolled back);
 *  - same key + different fingerprint → 422 IDEMPOTENCY_KEY_REUSED;
 *  - a failed request rolls everything back, including the reservation, so it can be retried.
 * Keys are scoped per tenant AND per principal, and expire after 24h.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tx: TransactionRunner,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const key = req.header('idempotency-key');
    if (!key || !KEY_PATTERN.test(key)) {
      throw new BusinessRuleError(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'This operation requires an Idempotency-Key header of 8-255 characters [A-Za-z0-9_-] (a UUID is recommended)',
      );
    }

    const principalId = this.cls.get('principal')?.id;
    const tenantId = this.cls.get('tenantId');
    if (!principalId || !tenantId) {
      // Fail closed: @Idempotent() on a route without a tenant principal is a programming error.
      throw new Error('@Idempotent() requires an authenticated tenant route');
    }

    const attempt: Attempt = {
      tenantId,
      principalId,
      key,
      fingerprint: sha256Hex(`${req.method}|${req.originalUrl}|${canonicalJson(req.body ?? {})}`),
      method: req.method,
      path: req.route ? `${req.baseUrl}${(req.route as { path: string }).path}` : req.path,
    };
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    const outcome = await this.tx.run(async (tx) => {
      const replay = await reserveOrReplay(tx, attempt);
      if (replay) return { replayed: true, ...replay };

      this.cls.set('ambientTx', tx);
      let body: unknown;
      try {
        body = await lastValueFrom(next.handle());
      } finally {
        this.cls.set('ambientTx', undefined);
      }
      await tx
        .updateTable('idempotency_keys')
        .set({
          status: 'COMPLETED',
          response_status: successStatus,
          response_body: canonicalJson(body ?? null),
        })
        .where('principal_id', '=', principalId)
        .where('idempotency_key', '=', key)
        .execute();
      return { replayed: false, status: successStatus, body };
    });

    if (outcome.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(outcome.status);
    }
    return outcome.body;
  }
}

/** Reserves the key, or returns the stored response of the request that already used it. */
async function reserveOrReplay(
  tx: Tx,
  a: Attempt,
): Promise<{ status: number; body: unknown } | undefined> {
  // Expired keys can be reused.
  await tx
    .deleteFrom('idempotency_keys')
    .where('principal_id', '=', a.principalId)
    .where('idempotency_key', '=', a.key)
    .where('expires_at', '<', sql<Date>`now()`)
    .execute();

  const inserted = await tx
    .insertInto('idempotency_keys')
    .values({
      tenant_id: a.tenantId,
      principal_id: a.principalId,
      idempotency_key: a.key,
      fingerprint: a.fingerprint,
      method: a.method,
      path: a.path,
      status: 'IN_PROGRESS',
      locked_at: sql<Date>`now()`,
      expires_at: sql<Date>`now() + interval '24 hours'`,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('idempotency_key')
    .executeTakeFirst();
  if (inserted) return undefined;

  const existing = await tx
    .selectFrom('idempotency_keys')
    .select(['fingerprint', 'response_status', 'response_body'])
    .where('principal_id', '=', a.principalId)
    .where('idempotency_key', '=', a.key)
    .executeTakeFirstOrThrow();
  if (existing.fingerprint !== a.fingerprint) {
    throw new BusinessRuleError(
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      'This Idempotency-Key was already used with a different request',
    );
  }
  // Rows only become visible once COMMITTED, i.e. completed.
  return { status: existing.response_status ?? HttpStatus.OK, body: existing.response_body };
}
