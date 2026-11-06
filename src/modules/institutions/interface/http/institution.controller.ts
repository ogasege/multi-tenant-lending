import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import type { BrandingView } from '../../application/branding.view';
import {
  CreateLogoUpload,
  type LogoUploadView,
} from '../../application/create-logo-upload.use-case';
import { GetBranding } from '../../application/get-branding.use-case';
import {
  GetInstitutionProfile,
  type InstitutionProfileView,
} from '../../application/get-institution-profile.use-case';
import { UpdateBranding } from '../../application/update-branding.use-case';

import {
  BrandingDto,
  CreateLogoUploadDto,
  LogoUploadDto,
  UpdateBrandingDto,
} from './dto/branding.dto';
import { InstitutionProfileDto } from './dto/institution-profile.dto';

/**
 * Every permission in the catalogue is held by at least one tenant role, and every tenant
 * role holds `product:read`; it is therefore the "any authenticated tenant user" permission
 * for read-only institution data (the guard requires at least one permission per route).
 */
const ANY_TENANT_USER = Permission.PRODUCT_READ;

/** The caller's own institution: profile (read-only) and white-label branding. */
@ApiTags('Institution')
@ApiBearerAuth()
@ApiProblemResponses(401, 403)
@Controller('institution')
export class InstitutionController {
  constructor(
    private readonly getProfile: GetInstitutionProfile,
    private readonly getBranding: GetBranding,
    private readonly updateBranding: UpdateBranding,
    private readonly createLogoUpload: CreateLogoUpload,
  ) {}

  @Get()
  @RequirePermissions(ANY_TENANT_USER)
  @ApiOperation({ summary: 'Get the caller’s institution profile (read-only)' })
  @ApiOkResponse({ type: InstitutionProfileDto })
  profile(): Promise<InstitutionProfileView> {
    return this.getProfile.execute();
  }

  @Get('branding')
  @RequirePermissions(ANY_TENANT_USER)
  @ApiOperation({ summary: 'Get the caller’s branding (includes `version` for updates)' })
  @ApiOkResponse({ type: BrandingDto })
  branding(): Promise<BrandingView> {
    return this.getBranding.execute();
  }

  @Put('branding')
  @RequirePermissions(Permission.INSTITUTION_MANAGE)
  @ApiOperation({
    summary: 'Replace the caller’s branding',
    description:
      'Optimistic concurrency: send the `version` from GET as `expectedVersion`; a stale ' +
      'value yields 409 CONCURRENT_MODIFICATION. Invalidates the public branding cache.',
  })
  @ApiOkResponse({ type: BrandingDto })
  @ApiProblemResponses(400, 409)
  update(
    @CurrentTenantUser() actor: TenantUser,
    @Body() dto: UpdateBrandingDto,
  ): Promise<BrandingView> {
    return this.updateBranding.execute({
      tenantId: actor.tenantId,
      expectedVersion: dto.expectedVersion,
      displayName: dto.displayName,
      primaryColor: dto.primaryColor,
      secondaryColor: dto.secondaryColor,
      supportEmail: dto.supportEmail,
      supportPhone: dto.supportPhone,
      websiteUrl: dto.websiteUrl,
      locale: dto.locale,
      logoObjectKey: dto.logoObjectKey,
    });
  }

  @Post('branding/logo-upload-url')
  @RequirePermissions(Permission.INSTITUTION_MANAGE)
  @ApiOperation({
    summary: 'Get a presigned S3 POST form for uploading a logo',
    description:
      'PNG, JPEG or WebP, 1 B – 1 MiB, valid for 5 minutes. POST `fields` then `file` as ' +
      'multipart/form-data to `url`, then PUT the branding with `logoObjectKey`. SVG is not ' +
      'accepted because it can embed script (stored XSS).',
  })
  @ApiCreatedResponse({ type: LogoUploadDto })
  @ApiProblemResponses(400)
  logoUpload(
    @CurrentTenantUser() actor: TenantUser,
    @Body() dto: CreateLogoUploadDto,
  ): Promise<LogoUploadView> {
    return this.createLogoUpload.execute(actor.tenantId, dto.contentType);
  }
}
