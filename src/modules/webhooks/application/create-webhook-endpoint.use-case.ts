import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { BusinessRuleError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import {
  MAX_ACTIVE_ENDPOINTS_PER_TENANT,
  toEndpointAuditView,
  type WebhookEndpointWithSecretView,
} from '../domain/webhook-endpoint';
import { generateSigningSecret, sealSecret } from '../domain/webhook-secret';
import {
  toEndpointView,
  WebhookEndpointsRepository,
} from '../infrastructure/webhook-endpoints.repository';
import { WebhookTargetGuard } from '../infrastructure/webhook-target-guard';

import { assertSafeWebhookUrl } from './webhook-url-validation';

export interface CreateWebhookEndpointInput {
  url: string;
  eventTypes: string[];
}

/**
 * Registers a webhook endpoint for the caller's institution. The URL passes the SSRF guard
 * (https, public addresses only) before anything is stored; the signing secret is generated
 * here, stored only as AES-256-GCM ciphertext bound to (tenant, endpoint), and returned in
 * plaintext exactly once, in this response.
 */
@Injectable()
export class CreateWebhookEndpoint {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: WebhookEndpointsRepository,
    private readonly guard: WebhookTargetGuard,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async execute(
    tenantId: string,
    input: CreateWebhookEndpointInput,
  ): Promise<WebhookEndpointWithSecretView> {
    // DNS resolution happens outside the transaction: it is slow and holds no locks.
    const url = await assertSafeWebhookUrl(this.guard, input.url);
    const eventTypes = [...new Set(input.eventTypes)].sort();
    const id = randomUUID();
    const secret = generateSigningSecret();
    const secretCiphertext = sealSecret(secret, this.config.DATA_ENCRYPTION_KEY, tenantId, id);

    return this.runner.run(async (tx) => {
      if ((await this.repo.countActive(tx)) >= MAX_ACTIVE_ENDPOINTS_PER_TENANT) {
        throw new BusinessRuleError(
          ErrorCode.WEBHOOK_ENDPOINT_LIMIT_REACHED,
          `An institution can have at most ${MAX_ACTIVE_ENDPOINTS_PER_TENANT} active webhook endpoints`,
        );
      }
      const view = toEndpointView(
        await this.repo.insert(tx, { id, tenantId, url, eventTypes, secretCiphertext }),
      );
      await this.audit.record(tx, {
        action: 'webhook_endpoint.created',
        entityType: 'webhook_endpoint',
        entityId: id,
        after: toEndpointAuditView(view),
      });
      await this.outbox.publish(tx, {
        type: 'webhook_endpoint.created',
        aggregateType: 'webhook_endpoint',
        aggregateId: id,
        data: { endpointId: id, eventTypes },
      });
      return { ...view, secret };
    });
  }
}
