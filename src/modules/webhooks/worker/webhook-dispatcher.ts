import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { SQS_CLIENT } from '../../../common/aws/sqs';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { WORKER_CONFIG } from '../../../config/worker-config.module';
import type { WorkerEnv } from '../../../config/worker-env.schema';
import type { TickResult } from '../../../worker/polling-loop';
import { type BackoffPolicy, retryDelayMs } from '../domain/backoff';
import {
  type DomainEventMessage,
  parseDomainEventMessage,
  webhookPayload,
} from '../domain/domain-event-message';
import { UnsafeWebhookTargetError } from '../domain/target-policy';
import { openSecret } from '../domain/webhook-secret';
import {
  type DeliveryCandidate,
  WebhookDeliveriesRepository,
} from '../infrastructure/webhook-deliveries.repository';
import { sendWebhook } from '../infrastructure/webhook-sender';
import { signWebhook } from '../infrastructure/webhook-signer';
import { WebhookTargetGuard } from '../infrastructure/webhook-target-guard';

/** Extra CA certificates trusted for webhook TLS (tests only; `null` = system roots). */
export const WEBHOOK_TLS_CA = Symbol('WEBHOOK_TLS_CA');

const MAX_ERROR_LENGTH = 500;
/** SQS caps a visibility timeout at 12 hours. */
const MAX_VISIBILITY_SECONDS = 43_200;

export type DispatchOutcome = 'delivered' | 'retry';

/**
 * SQS consumer that turns domain events into signed webhook deliveries (SPEC §9).
 *
 * For each message: load the event as committed in the tenant's outbox (the message body is
 * only a locator, never signed as is), find the tenant's ACTIVE endpoints subscribed to the
 * event type, skip
 * those that already acknowledged this event (redeliveries are per endpoint, never a blind
 * replay to everyone), sign the canonical JSON body with Standard Webhooks, POST it through
 * the SSRF guard (re-checked at delivery time, pinned IP) with a 10 s timeout, and record
 * one `webhook_deliveries` row per attempt.
 *
 * All endpoints done → the message is deleted. Otherwise its visibility timeout is set to the
 * exponential backoff for this receive count, so SQS redelivers it later; after 5 receives
 * the queue's redrive policy moves it to the DLQ. Receivers deduplicate on `webhook-id`.
 *
 * Event types are not special-cased: every outbox event is deliverable to endpoints that
 * subscribe to it by name. This is also the OUT-OF-BAND NOTIFICATION PATH for security
 * events such as `auth.account_locked` (and `auth.*` generally): a lender subscribes its
 * SIEM / alerting endpoint to them; there is no separate notification consumer.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly backoff: BackoffPolicy;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(WORKER_CONFIG) private readonly config: WorkerEnv,
    @Inject(WEBHOOK_TLS_CA) private readonly ca: string | null,
    private readonly runner: TransactionRunner,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly guard: WebhookTargetGuard,
  ) {
    this.backoff = {
      baseMs: config.WEBHOOK_RETRY_BASE_SECONDS * 1000,
      maxMs: config.WEBHOOK_RETRY_MAX_SECONDS * 1000,
    };
  }

  /** One long-poll receive (cancelled by `signal` on shutdown) and its processing. */
  async pollOnce(signal: AbortSignal): Promise<TickResult> {
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.SQS_DOMAIN_EVENTS_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.SQS_WAIT_TIME_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: signal },
    );
    // Received messages are always processed to completion, even during shutdown.
    await Promise.all(messages.map((m) => this.handleMessage(m)));
    return messages.length > 0 ? 'busy' : 'idle';
  }

  async handleMessage(message: Message): Promise<DispatchOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const event = parseDomainEventMessage(message.Body);
    let outcome: DispatchOutcome = 'retry';
    if (!event) {
      // Left on the queue: after the redrive limit it lands in the DLQ for inspection.
      this.logger.error({ msg: 'malformed domain event message', messageId: message.MessageId });
    } else {
      try {
        outcome = await this.dispatch(event);
      } catch (err) {
        this.logger.error({ msg: 'webhook dispatch failed', eventId: event.id, err });
      }
    }

    if (outcome === 'delivered') {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.SQS_DOMAIN_EVENTS_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } else {
      const delaySeconds = Math.min(
        Math.ceil(retryDelayMs(receiveCount, this.backoff) / 1000),
        MAX_VISIBILITY_SECONDS,
      );
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.SQS_DOMAIN_EVENTS_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
      this.logger.warn({
        msg: 'webhook delivery incomplete; redelivery scheduled',
        eventId: event?.id,
        receiveCount,
        retryInSeconds: delaySeconds,
      });
    }
    return outcome;
  }

  /**
   * Delivers to every pending endpoint; `delivered` when none is left pending.
   *
   * The queue message only LOCATES the event (id, tenant): what is signed and sent is the
   * row committed in `outbox_events`, read in the tenant's own RLS transaction. A message
   * whose body was altered, or that names another tenant, can therefore neither change the
   * payload nor reach another tenant's endpoints; one whose event is not found is left for
   * the DLQ.
   */
  async dispatch(message: DomainEventMessage): Promise<DispatchOutcome> {
    const found = await this.runner.runForTenant(message.tenantId, async (tx) => {
      const event = await this.deliveries.storedEvent(tx, message.id);
      if (!event) return undefined;
      return { event, candidates: await this.deliveries.candidates(tx, event.id, event.type) };
    });
    if (!found) {
      this.logger.error({
        msg: 'domain event not found in its tenant outbox; not delivered',
        eventId: message.id,
        tenantId: message.tenantId,
      });
      return 'retry';
    }
    const { event, candidates } = found;
    const pending = candidates.filter((c) => !c.alreadySucceeded);
    const results = await Promise.all(pending.map((c) => this.deliver(event, c)));
    return results.every(Boolean) ? 'delivered' : 'retry';
  }

  private async deliver(event: DomainEventMessage, endpoint: DeliveryCandidate): Promise<boolean> {
    const attempt = endpoint.previousAttempts + 1;
    const started = performance.now();
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      // Re-checked at every delivery: DNS may have changed since the endpoint was registered.
      const target = await this.guard.check(endpoint.url);
      const secret = openSecret(
        endpoint.secretCiphertext,
        this.config.DATA_ENCRYPTION_KEY,
        event.tenantId,
        endpoint.endpointId,
      );
      const body = webhookPayload(event);
      const response = await sendWebhook({
        target,
        body,
        headers: { ...signWebhook(secret, event.id, new Date(), body) },
        timeoutMs: this.config.WEBHOOK_TIMEOUT_MS,
        ca: this.ca ?? undefined,
      });
      responseStatus = response.status;
      if (response.status < 200 || response.status > 299) error = `HTTP ${response.status}`;
    } catch (err) {
      error = describe(err);
    }
    const succeeded = error === null;
    const durationMs = Math.round(performance.now() - started);
    await this.runner.runForTenant(event.tenantId, (tx) =>
      this.deliveries.record(tx, {
        tenantId: event.tenantId,
        endpointId: endpoint.endpointId,
        eventId: event.id,
        attempt,
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        responseStatus,
        error: error?.slice(0, MAX_ERROR_LENGTH) ?? null,
        durationMs,
      }),
    );
    this.logger.log({
      msg: succeeded ? 'webhook delivered' : 'webhook delivery failed',
      tenantId: event.tenantId,
      eventId: event.id,
      eventType: event.type,
      endpointId: endpoint.endpointId,
      attempt,
      responseStatus,
      durationMs,
      error,
    });
    return succeeded;
  }
}

function describe(err: unknown): string {
  if (err instanceof UnsafeWebhookTargetError) return `UNSAFE_TARGET ${err.reason}: ${err.message}`;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
