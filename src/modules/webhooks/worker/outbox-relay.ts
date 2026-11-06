import {
  type SendMessageBatchRequestEntry,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { SQS_CLIENT } from '../../../common/aws/sqs';
import { type Db, type Tx, WORKER_DB } from '../../../common/database/database.tokens';
import { WORKER_CONFIG } from '../../../config/worker-config.module';
import type { WorkerEnv } from '../../../config/worker-env.schema';
import { DirectoryProjector } from '../../directory/application/directory-projector';
import { ProjectionConflictReporter } from '../../directory/application/projection-conflict';
import type { DirectoryEntry } from '../../directory/domain/directory-entry';
import { type BackoffPolicy, uncappedAttempts } from '../domain/backoff';
import type { DomainEventMessage } from '../domain/domain-event-message';

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  /** occurred_at in microseconds since the epoch, computed in SQL (keeps full precision). */
  version: string;
}

/** SQS SendMessageBatch accepts at most 10 entries. */
const SQS_BATCH_LIMIT = 10;
const MAX_ERROR_LENGTH = 1000;

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Transactional-outbox relay (SPEC §9): moves committed `outbox_events` to the SQS
 * `domain-events` queue.
 *
 * Each batch is one transaction on the `lending_worker` role that claims due rows with
 * `FOR UPDATE SKIP LOCKED`, so any number of worker tasks can run side by side without
 * double-claiming; a row is marked `published_at` only after SQS acknowledged it. A crash
 * between the SQS send and the COMMIT re-sends the event later, so delivery is
 * at-least-once and consumers deduplicate on the event id (the message `id`).
 *
 * Failures increment `attempts` and record `last_error`; the row is retried with
 * exponential backoff derived from `occurred_at` + `attempts` (see `cumulativeRetryDelayMs`),
 * so a poisoned row never blocks the rows behind it.
 *
 * After the commit, `institution.*` events are also projected into the tenant directory
 * (best effort: the periodic reconciler repairs anything missed).
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly backoff: BackoffPolicy;

  constructor(
    @Inject(WORKER_DB) private readonly db: Db,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(WORKER_CONFIG) private readonly config: WorkerEnv,
    private readonly projector: DirectoryProjector,
    private readonly conflicts: ProjectionConflictReporter,
  ) {
    this.backoff = { baseMs: config.OUTBOX_RETRY_BASE_MS, maxMs: config.OUTBOX_RETRY_MAX_MS };
  }

  async relayBatch(): Promise<RelayResult> {
    const outcome = await this.db.transaction().execute(async (tx) => {
      const rows = await this.claim(tx);
      if (rows.length === 0) return { rows, published: [] as OutboxRow[], failed: 0 };
      const failures = await this.publish(rows);
      const published = rows.filter((r) => !failures.has(r.id));
      if (published.length > 0) {
        await tx
          .updateTable('outbox_events')
          .set({ published_at: sql<Date>`now()` })
          .where(
            'id',
            'in',
            published.map((r) => r.id),
          )
          .execute();
      }
      for (const [id, error] of failures) {
        await tx
          .updateTable('outbox_events')
          .set((eb) => ({
            attempts: eb('attempts', '+', 1),
            last_error: error.slice(0, MAX_ERROR_LENGTH),
          }))
          .where('id', '=', id)
          .execute();
      }
      return { rows, published, failed: failures.size };
    });

    if (outcome.failed > 0) {
      this.logger.warn({
        msg: 'outbox events not published; will retry with backoff',
        failed: outcome.failed,
      });
    }
    await this.projectInstitutionEvents(outcome.published);
    return {
      claimed: outcome.rows.length,
      published: outcome.published.length,
      failed: outcome.failed,
    };
  }

  /**
   * Due rows: unpublished and past their backoff. The retry schedule in SQL equals
   * `cumulativeRetryDelayMs(attempts)`: base·(2^a − 1) while doubling, then + max per attempt.
   */
  private async claim(tx: Tx): Promise<OutboxRow[]> {
    const { baseMs, maxMs } = this.backoff;
    const k = uncappedAttempts(this.backoff);
    const { rows } = await sql<OutboxRow>`
      SELECT id, tenant_id, event_type, aggregate_type, aggregate_id, payload, occurred_at,
             ((extract(epoch FROM occurred_at) * 1000000)::bigint)::text AS version
        FROM outbox_events
       WHERE published_at IS NULL
         AND occurred_at + interval '1 millisecond' * (
               CASE WHEN attempts <= ${k}::int
                    THEN ${baseMs}::float8 * (power(2::float8, attempts) - 1)
                    ELSE ${baseMs}::float8 * (power(2::float8, ${k}::int) - 1)
                         + (attempts - ${k}::int) * ${maxMs}::float8
               END) <= now()
       ORDER BY occurred_at
       LIMIT ${this.config.OUTBOX_BATCH_SIZE}::int
       FOR UPDATE SKIP LOCKED`.execute(tx);
    return rows;
  }

  /** Sends the rows in batches of 10; returns the ids that failed with their error. */
  private async publish(rows: OutboxRow[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    for (let i = 0; i < rows.length; i += SQS_BATCH_LIMIT) {
      const chunk = rows.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const result = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.config.SQS_DOMAIN_EVENTS_QUEUE_URL,
            Entries: chunk.map(toEntry),
          }),
          { abortSignal: AbortSignal.timeout(10_000) },
        );
        for (const f of result.Failed ?? []) {
          if (f.Id) failures.set(f.Id, `${f.Code ?? 'SQS_ERROR'}: ${f.Message ?? 'send failed'}`);
        }
        const acknowledged = new Set((result.Successful ?? []).map((s) => s.Id));
        for (const row of chunk) {
          if (!acknowledged.has(row.id) && !failures.has(row.id)) {
            failures.set(row.id, 'SQS did not acknowledge the message');
          }
        }
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        for (const row of chunk) failures.set(row.id, message);
      }
    }
    return failures;
  }

  private async projectInstitutionEvents(rows: OutboxRow[]): Promise<void> {
    for (const row of rows) {
      if (!row.event_type.startsWith('institution.')) continue;
      try {
        const outcome = await this.projector.project({
          type: row.event_type,
          version: Number(row.version),
          payload: row.payload,
        });
        if (outcome.result === 'stale')
          await this.reportConflict(row, outcome.slug, outcome.current);
        this.logger.log({
          msg: 'directory projection',
          eventId: row.id,
          eventType: row.event_type,
          tenantId: row.tenant_id,
          result: outcome.result,
        });
      } catch (err) {
        this.logger.error({
          msg: 'directory projection failed; the reconciler will repair it',
          eventId: row.id,
          tenantId: row.tenant_id,
          err,
        });
      }
    }
  }

  /** Distinguishes a harmless replay from a slug owned by another institution or cell. */
  private async reportConflict(
    row: OutboxRow,
    slug: string,
    current: DirectoryEntry | undefined,
  ): Promise<void> {
    const institutionId = row.payload.institutionId;
    if (typeof institutionId !== 'string') return;
    await this.conflicts.reportIfConflicting(slug, institutionId, current, {
      eventId: row.id,
      eventType: row.event_type,
    });
  }
}

function toEntry(row: OutboxRow): SendMessageBatchRequestEntry {
  const message: DomainEventMessage = {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.occurred_at.toISOString(),
    data: row.payload,
  };
  return {
    // Batch entry ids must be unique per request: the event id is.
    Id: row.id,
    MessageBody: JSON.stringify(message),
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: row.event_type },
      tenantId: { DataType: 'String', StringValue: row.tenant_id },
    },
  };
}
