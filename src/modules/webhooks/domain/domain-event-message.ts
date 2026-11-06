import { canonicalJson } from '../../../common/crypto/crypto';

/**
 * The domain-event envelope the outbox relay puts on the SQS `domain-events` queue (message
 * body, JSON). `id` is the outbox event id: SQS standard queues deliver at least once, so
 * every consumer deduplicates on it (webhook receivers see it as the `webhook-id` header).
 */
export interface DomainEventMessage {
  id: string;
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  /** ISO-8601 timestamp of the business transaction that produced the event. */
  occurredAt: string;
  data: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses and validates a queue message body; returns undefined for anything malformed. */
export function parseDomainEventMessage(body: string | undefined): DomainEventMessage | undefined {
  if (!body) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const m = value as Record<string, unknown>;
  const { id, tenantId, type, aggregateType, aggregateId, occurredAt, data } = m;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof tenantId !== 'string' ||
    !UUID.test(tenantId) ||
    typeof type !== 'string' ||
    !type ||
    typeof aggregateType !== 'string' ||
    typeof aggregateId !== 'string' ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(Date.parse(occurredAt)) ||
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data)
  ) {
    return undefined;
  }
  return {
    id,
    tenantId,
    type,
    aggregateType,
    aggregateId,
    occurredAt,
    data: data as Record<string, unknown>,
  };
}

/**
 * Webhook request body: the Standard Webhooks recommended shape `{type, timestamp, data}`
 * plus the event id, serialised as RFC 8785 canonical JSON so the signed bytes are
 * reproducible in any language. The tenant is implied by the endpoint and never sent.
 */
export function webhookPayload(event: DomainEventMessage): string {
  return canonicalJson({
    id: event.id,
    type: event.type,
    timestamp: event.occurredAt,
    data: event.data,
  });
}
