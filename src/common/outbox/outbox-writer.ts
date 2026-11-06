import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';
import { canonicalJson } from '../crypto/crypto';
import type { Tx } from '../database/database.tokens';

export interface DomainEvent {
  type: string; // e.g. 'loan.disbursed' — also the webhook event type
  aggregateType: string;
  aggregateId: string;
  data: Record<string, unknown>;
  tenantId?: string;
}

/**
 * Transactional outbox: the event row is written in the SAME transaction as the business
 * change, so an event exists if and only if the change committed (no dual-write problem).
 * The worker relays unpublished rows to SQS; delivery is at-least-once, consumers dedupe on
 * the event id.
 */
@Injectable()
export class OutboxWriter {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  async publish(tx: Tx, event: DomainEvent): Promise<string> {
    const tenantId = event.tenantId ?? (this.cls.isActive() ? this.cls.get('tenantId') : undefined);
    if (!tenantId) throw new Error('Outbox event requires a tenant');
    const row = await tx
      .insertInto('outbox_events')
      .values({
        tenant_id: tenantId,
        event_type: event.type,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        payload: canonicalJson(event.data),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
