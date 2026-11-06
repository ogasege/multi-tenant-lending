import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../../../common/auth/decorators';
import { Permission } from '../../../../common/auth/permissions';
import type { Page } from '../../../../common/http/pagination';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import { CreateWebhookEndpoint } from '../../application/create-webhook-endpoint.use-case';
import { DisableWebhookEndpoint } from '../../application/disable-webhook-endpoint.use-case';
import { ListWebhookEndpoints } from '../../application/list-webhook-endpoints.use-case';
import { RotateWebhookSecret } from '../../application/rotate-webhook-secret.use-case';
import type {
  WebhookEndpointView,
  WebhookEndpointWithSecretView,
} from '../../domain/webhook-endpoint';

import {
  CreateWebhookEndpointDto,
  ListWebhookEndpointsQueryDto,
  WebhookEndpointPageDto,
  WebhookEndpointWithSecretDto,
} from './webhook-endpoint.dto';

const DELIVERY_CONTRACT =
  'Deliveries follow Standard Webhooks: POST with `webhook-id` (the event id), ' +
  '`webhook-timestamp` and `webhook-signature` (`v1,<base64 HMAC-SHA256>`) headers and a ' +
  'canonical JSON body `{id, type, timestamp, data}`. Delivery is at-least-once: ' +
  'receivers must verify the signature and deduplicate on `webhook-id`. Non-2xx responses ' +
  'and timeouts (10 s) are retried with exponential backoff, at most 5 times.';

/** Outbound webhook configuration of the caller's institution (SPEC §9, §10). */
@ApiTags('Webhooks')
@ApiBearerAuth()
@RequirePermissions(Permission.INSTITUTION_MANAGE)
@ApiProblemResponses(401, 403)
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(
    private readonly createEndpoint: CreateWebhookEndpoint,
    private readonly listEndpoints: ListWebhookEndpoints,
    private readonly disableEndpoint: DisableWebhookEndpoint,
    private readonly rotateSecret: RotateWebhookSecret,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Register a webhook endpoint (returns the signing secret once)',
    description:
      `${DELIVERY_CONTRACT} The URL must be https:// and resolve to public addresses only ` +
      '(422 UNSAFE_WEBHOOK_URL); at most 20 active endpoints per institution.',
  })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretDto })
  @ApiProblemResponses(400, 422)
  create(
    @CurrentTenantUser() actor: TenantUser,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointWithSecretView> {
    return this.createEndpoint.execute(actor.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List webhook endpoints (cursor pagination, no secrets)' })
  @ApiOkResponse({ type: WebhookEndpointPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: ListWebhookEndpointsQueryDto): Promise<Page<WebhookEndpointView>> {
    return this.listEndpoints.execute(query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disable a webhook endpoint',
    description: 'Stops deliveries; the endpoint and its delivery history are kept for audit.',
  })
  @ApiNoContentResponse({ description: 'Disabled (also when it already was)' })
  @ApiProblemResponses(400, 404)
  disable(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.disableEndpoint.execute(id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the signing secret (returns the new secret once)',
    description: 'Takes effect immediately for every subsequent delivery attempt.',
  })
  @ApiOkResponse({ type: WebhookEndpointWithSecretDto })
  @ApiProblemResponses(400, 404, 409)
  rotate(
    @CurrentTenantUser() actor: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebhookEndpointWithSecretView> {
    return this.rotateSecret.execute(actor.tenantId, id);
  }
}
