import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { toEndpointAuditView } from '../domain/webhook-endpoint';
import {
  toEndpointView,
  WebhookEndpointsRepository,
} from '../infrastructure/webhook-endpoints.repository';

/**
 * Disables an endpoint (the DELETE route): no further deliveries; the row and its delivery
 * history are kept for audit. Disabling an already disabled endpoint is a no-op.
 */
@Injectable()
export class DisableWebhookEndpoint {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: WebhookEndpointsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  execute(id: string): Promise<void> {
    return this.runner.run(async (tx) => {
      const before = await this.repo.findForUpdate(tx, id);
      if (!before) throw new NotFoundError('Webhook endpoint', id);
      if (before.status === 'DISABLED') return;

      const after = await this.repo.setStatus(tx, id, 'DISABLED');
      await this.audit.record(tx, {
        action: 'webhook_endpoint.disabled',
        entityType: 'webhook_endpoint',
        entityId: id,
        before: toEndpointAuditView(toEndpointView(before)),
        after: toEndpointAuditView(toEndpointView(after)),
      });
      await this.outbox.publish(tx, {
        type: 'webhook_endpoint.disabled',
        aggregateType: 'webhook_endpoint',
        aggregateId: id,
        data: { endpointId: id },
      });
    });
  }
}
