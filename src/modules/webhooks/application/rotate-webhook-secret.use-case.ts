import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { InvalidStateTransitionError, NotFoundError } from '../../../common/errors/app-error';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import {
  toEndpointAuditView,
  type WebhookEndpointWithSecretView,
} from '../domain/webhook-endpoint';
import { generateSigningSecret, sealSecret } from '../domain/webhook-secret';
import {
  toEndpointView,
  WebhookEndpointsRepository,
} from '../infrastructure/webhook-endpoints.repository';

/**
 * Replaces an active endpoint's signing secret and returns the new one, once. Rotation is
 * immediate: deliveries signed after the commit use the new secret, so the receiver should
 * accept both secrets while it rolls the new one out (Standard Webhooks verifiers take a
 * list of signatures; the old secret is not kept here).
 */
@Injectable()
export class RotateWebhookSecret {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: WebhookEndpointsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  execute(tenantId: string, id: string): Promise<WebhookEndpointWithSecretView> {
    return this.runner.run(async (tx) => {
      const before = await this.repo.findForUpdate(tx, id);
      if (!before) throw new NotFoundError('Webhook endpoint', id);
      if (before.status !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          'webhook endpoint',
          before.status,
          'rotate the secret of',
        );
      }
      const secret = generateSigningSecret();
      const ciphertext = sealSecret(secret, this.config.DATA_ENCRYPTION_KEY, tenantId, id);
      const view = toEndpointView(await this.repo.setSecret(tx, id, ciphertext));

      await this.audit.record(tx, {
        action: 'webhook_endpoint.secret_rotated',
        entityType: 'webhook_endpoint',
        entityId: id,
        after: toEndpointAuditView(view),
      });
      await this.outbox.publish(tx, {
        type: 'webhook_endpoint.secret_rotated',
        aggregateType: 'webhook_endpoint',
        aggregateId: id,
        data: { endpointId: id },
      });
      return { ...view, secret };
    });
  }
}
