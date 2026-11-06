import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { Tx } from '../../../common/database/database.tokens';
import type { DomainEventMessage } from '../domain/domain-event-message';

/** An active endpoint subscribed to an event, with its delivery history for that event. */
export interface DeliveryCandidate {
  endpointId: string;
  url: string;
  secretCiphertext: string;
  previousAttempts: number;
  alreadySucceeded: boolean;
}

export interface DeliveryRecord {
  tenantId: string;
  endpointId: string;
  eventId: string;
  attempt: number;
  status: 'SUCCEEDED' | 'FAILED';
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * Dispatcher persistence. Runs in a tenant transaction on `lending_app` (RLS enforced): the
 * dispatcher only ever needs the event's own tenant, so it does not use the cross-tenant
 * worker role.
 */
@Injectable()
export class WebhookDeliveriesRepository {
  async candidates(tx: Tx, eventId: string, eventType: string): Promise<DeliveryCandidate[]> {
    const rows = await tx
      .selectFrom('webhook_endpoints as e')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('webhook_deliveries')
            .select([
              'endpoint_id',
              sql<string>`count(*)`.as('attempts'),
              sql<boolean>`bool_or(status = 'SUCCEEDED')`.as('succeeded'),
            ])
            .where('event_id', '=', eventId)
            .groupBy('endpoint_id')
            .as('d'),
        (join) => join.onRef('d.endpoint_id', '=', 'e.id'),
      )
      .select(['e.id', 'e.url', 'e.secret_ciphertext', 'd.attempts', 'd.succeeded'])
      .where('e.status', '=', 'ACTIVE')
      .where(sql<boolean>`e.event_types @> ARRAY[${eventType}]::text[]`)
      .orderBy('e.created_at')
      .execute();
    return rows.map((r) => ({
      endpointId: r.id,
      url: r.url,
      secretCiphertext: r.secret_ciphertext,
      previousAttempts: Number(r.attempts ?? 0),
      alreadySucceeded: r.succeeded === true,
    }));
  }

  /**
   * The event as committed in `outbox_events`: what is signed and delivered. Under RLS the
   * row is only visible in its own tenant's transaction, so a queue message naming the wrong
   * tenant (or an id that was never written) finds nothing.
   */
  async storedEvent(tx: Tx, eventId: string): Promise<DomainEventMessage | undefined> {
    const row = await tx
      .selectFrom('outbox_events')
      .select([
        'id',
        'tenant_id',
        'event_type',
        'aggregate_type',
        'aggregate_id',
        'payload',
        'occurred_at',
      ])
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!row) return undefined;
    const payload = row.payload;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      type: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at.toISOString(),
      data:
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {},
    };
  }

  async record(tx: Tx, d: DeliveryRecord): Promise<void> {
    await tx
      .insertInto('webhook_deliveries')
      .values({
        tenant_id: d.tenantId,
        endpoint_id: d.endpointId,
        event_id: d.eventId,
        attempt: d.attempt,
        status: d.status,
        response_status: d.responseStatus,
        error: d.error,
        duration_ms: d.durationMs,
      })
      .execute();
  }
}
