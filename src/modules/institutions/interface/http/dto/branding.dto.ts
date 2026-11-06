import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import {
  E164_PHONE,
  HEX_COLOR,
  LOCALE,
  LOGO_CONTENT_TYPES,
  type LogoContentType,
} from '../../../domain/branding-rules';

/** Full replacement of the tenant's branding (PUT semantics: omitted optionals become null). */
export class UpdateBrandingDto {
  @ApiProperty({ example: 'Acme Health Credit', minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  displayName!: string;

  @ApiProperty({ example: '#0B5FFF', pattern: HEX_COLOR.source })
  @Matches(HEX_COLOR, { message: 'primaryColor must be #RRGGBB' })
  primaryColor!: string;

  @ApiProperty({ example: '#111827', pattern: HEX_COLOR.source })
  @Matches(HEX_COLOR, { message: 'secondaryColor must be #RRGGBB' })
  secondaryColor!: string;

  @ApiPropertyOptional({ example: 'support@acme.example', nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  supportEmail?: string | null;

  @ApiPropertyOptional({ example: '+2348012345678', description: 'E.164', nullable: true })
  @IsOptional()
  @Matches(E164_PHONE, { message: 'supportPhone must be an E.164 number, e.g. +2348012345678' })
  supportPhone?: string | null;

  @ApiPropertyOptional({ example: 'https://acme.example', description: 'HTTPS only' })
  @IsOptional()
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_tld: true },
    { message: 'websiteUrl must be an https:// URL' },
  )
  @MaxLength(2048)
  websiteUrl?: string | null;

  @ApiProperty({ example: 'en-NG', description: 'BCP 47 tag: en-NG, fr-SN, en-GB, fr-FR, …' })
  @Matches(LOCALE, { message: 'locale must be a BCP 47 tag such as en-NG or fr-SN' })
  locale!: string;

  @ApiPropertyOptional({
    description:
      'Key returned by POST /v1/institution/branding/logo-upload-url after the upload ' +
      'succeeded. Must belong to the caller’s tenant. Null removes the logo.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoObjectKey?: string | null;

  @ApiProperty({ description: 'Version read from GET (optimistic concurrency)', example: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class BrandingDto {
  @ApiProperty() displayName!: string;
  @ApiProperty({ example: '#0B5FFF' }) primaryColor!: string;
  @ApiProperty({ example: '#111827' }) secondaryColor!: string;
  @ApiProperty({ type: String, nullable: true }) supportEmail!: string | null;
  @ApiProperty({ type: String, nullable: true }) supportPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) websiteUrl!: string | null;
  @ApiProperty({ example: 'en-NG' }) locale!: string;
  @ApiProperty({ type: String, nullable: true }) logoObjectKey!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Presigned GET URL, valid 1 h' })
  logoUrl!: string | null;

  @ApiProperty({ description: 'Send back as expectedVersion on PUT' }) version!: number;
  @ApiProperty() updatedAt!: Date;
}

export class CreateLogoUploadDto {
  @ApiProperty({
    enum: Object.keys(LOGO_CONTENT_TYPES),
    description: 'SVG is not accepted (it can carry script — stored XSS risk)',
  })
  @IsIn(Object.keys(LOGO_CONTENT_TYPES))
  contentType!: LogoContentType;
}

export class LogoUploadDto {
  @ApiProperty({ description: 'POST a multipart/form-data form here' }) url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Form fields to send verbatim, before the `file` field',
  })
  fields!: Record<string, string>;

  @ApiProperty({ example: 'tenants/<tenantId>/branding/logo-<uuid>.png' }) objectKey!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ example: 1048576 }) maxBytes!: number;
}

export class PublicBrandingDto {
  @ApiProperty() slug!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() primaryColor!: string;
  @ApiProperty() secondaryColor!: string;
  @ApiProperty() locale!: string;
  @ApiProperty({ example: 'NGN', description: 'ISO 4217 code amounts default to' })
  defaultCurrency!: string;

  @ApiProperty({ type: [String], example: ['NGN'], description: 'ISO 4217 codes offered' })
  supportedCurrencies!: string[];

  @ApiProperty({ type: String, nullable: true }) supportEmail!: string | null;
  @ApiProperty({ type: String, nullable: true }) supportPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) websiteUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Presigned GET URL, valid ≥ 59 min' })
  logoUrl!: string | null;
}
