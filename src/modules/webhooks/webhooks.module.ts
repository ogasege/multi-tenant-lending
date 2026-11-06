import { Module } from '@nestjs/common';

import { CreateWebhookEndpoint } from './application/create-webhook-endpoint.use-case';
import { DisableWebhookEndpoint } from './application/disable-webhook-endpoint.use-case';
import { ListWebhookEndpoints } from './application/list-webhook-endpoints.use-case';
import { RotateWebhookSecret } from './application/rotate-webhook-secret.use-case';
import { WebhookEndpointsRepository } from './infrastructure/webhook-endpoints.repository';
import { WEBHOOK_TARGET_GUARD_PROVIDERS } from './infrastructure/webhook-target-guard';
import { WebhookEndpointsController } from './interface/http/webhook-endpoints.controller';

/**
 * HTTP API side of webhooks: endpoint registration, listing, disabling and secret rotation
 * (permission `institution:manage`). Delivery runs in the worker (WebhooksWorkerModule).
 */
@Module({
  controllers: [WebhookEndpointsController],
  providers: [
    ...WEBHOOK_TARGET_GUARD_PROVIDERS,
    WebhookEndpointsRepository,
    CreateWebhookEndpoint,
    ListWebhookEndpoints,
    DisableWebhookEndpoint,
    RotateWebhookSecret,
  ],
})
export class WebhooksModule {}
