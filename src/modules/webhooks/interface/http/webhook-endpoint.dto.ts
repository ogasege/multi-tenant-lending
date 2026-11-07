import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PageDto, PageQueryDto } from '../../../../common/http/pagination';
import { DOMAIN_EVENT_TYPES } from '../../../../common/outbox/event-types';
import {
  EVENT_TYPE_PATTERN,
  MAX_EVENT_TYPES,
  WEBHOOK_ENDPOINT_STATUSES,
  type WebhookEndpointStatus,
} from '../../domain/webhook-endpoint';

export class CreateWebhookEndpointDto {
  @ApiProperty({
    example: 'https://erp.example.com/hooks/10mg',
    description:
      'https:// only. The host must resolve to public addresses only (SSRF guard); ' +
      'it is re-checked at every delivery.',
    maxLength: 2048,
  })
  @IsString()
  @MaxLength(2048)
  url!: string;

  @ApiProperty({
    type: [String],
    enum: DOMAIN_EVENT_TYPES,
    example: ['loan.disbursed', 'loan.repayment_received'],
    description: `Event types to receive (1–${MAX_EVENT_TYPES}); unknown types are rejected`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENT_TYPES)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(EVENT_TYPE_PATTERN, {
    each: true,
    message: 'eventTypes must be dotted lower-case event names such as loan.disbursed',
  })
  @IsIn(DOMAIN_EVENT_TYPES, { each: true, message: 'eventTypes contains an unknown event type' })
  eventTypes!: string[];
}

export class ListWebhookEndpointsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: WEBHOOK_ENDPOINT_STATUSES })
  @IsOptional()
  @IsIn(WEBHOOK_ENDPOINT_STATUSES)
  status?: WebhookEndpointStatus;
}

export class WebhookEndpointDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'https://erp.example.com/hooks/10mg' }) url!: string;
  @ApiProperty({ type: [String], example: ['loan.disbursed'] }) eventTypes!: string[];
  @ApiProperty({ enum: WEBHOOK_ENDPOINT_STATUSES }) status!: WebhookEndpointStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class WebhookEndpointWithSecretDto extends WebhookEndpointDto {
  @ApiProperty({
    example: 'whsec_<base64 of 32 random bytes>',
    description:
      'Standard Webhooks signing secret. Returned ONLY in this response: store it now. ' +
      'Verify deliveries with a Standard Webhooks library and deduplicate on `webhook-id`.',
  })
  secret!: string;
}

export class WebhookEndpointPageDto extends PageDto(WebhookEndpointDto) {}
