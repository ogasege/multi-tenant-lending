import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import type { ChainVerification } from '../../../../common/audit/audit-writer';
import type { ActorType } from '../../../../common/database/schema';
import { PageDto, PageQueryDto } from '../../../../common/http/pagination';
import type { AuditLogView } from '../../application/audit-queries.use-case';

const ACTOR_TYPES: ActorType[] = ['PLATFORM_ADMIN', 'USER', 'SYSTEM'];

export class AuditLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 'loan' })
  @IsOptional()
  @Matches(/^[a-z_]{1,64}$/, { message: 'entityType must be lower_snake_case' })
  entityType?: string;

  @ApiPropertyOptional({ description: 'Entity id (usually a UUID)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityId?: string;

  @ApiPropertyOptional({ example: 'loan.disbursed' })
  @IsOptional()
  @Matches(/^[a-z_.]{1,100}$/, { message: 'action must look like entity.verb' })
  action?: string;
}

export class AuditLogDto implements AuditLogView {
  @ApiProperty({ example: '42', description: 'Chain position (identity)' }) id!: string;
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: ActorType;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) actorId!: string | null;
  @ApiProperty({ example: 'loan.disbursed' }) action!: string;
  @ApiProperty({ example: 'loan' }) entityType!: string;
  @ApiProperty() entityId!: string;
  @ApiProperty({ type: Object, nullable: true, description: 'Sanitised state before' })
  before!: unknown;
  @ApiProperty({ type: Object, nullable: true, description: 'Sanitised state after' })
  after!: unknown;
  @ApiProperty({ type: String, nullable: true }) requestId!: string | null;
  @ApiProperty({ type: String, nullable: true }) ipAddress!: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty() prevHash!: string;
  @ApiProperty() hash!: string;
}

export class AuditLogPageDto extends PageDto(AuditLogDto) {}

export class ChainVerificationDto implements ChainVerification {
  @ApiProperty() valid!: boolean;
  @ApiProperty() entriesChecked!: number;
  @ApiPropertyOptional({ description: 'Id of the first entry whose hash does not verify' })
  firstBrokenEntryId?: string;
}
