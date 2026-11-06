import { Module } from '@nestjs/common';

import { AwsModule } from '../../common/aws/aws.module';
import { TenantResolver } from '../../common/database/tenant-resolver';

import { CreateLogoUpload } from './application/create-logo-upload.use-case';
import { GetBranding } from './application/get-branding.use-case';
import { GetInstitutionProfile } from './application/get-institution-profile.use-case';
import { GetPublicBranding } from './application/get-public-branding.use-case';
import { UpdateBranding } from './application/update-branding.use-case';
import { BrandingAssets } from './infrastructure/branding-assets';
import { BrandingCache } from './infrastructure/branding-cache';
import { InstitutionsRepository } from './infrastructure/institutions.repository';
import { InstitutionController } from './interface/http/institution.controller';
import { PublicBrandingController } from './interface/http/public-branding.controller';

/**
 * Institution profile and white-label branding (SPEC §10). Exports `BrandingCache` so the
 * platform module can invalidate an institution's public branding when it is suspended.
 */
@Module({
  imports: [AwsModule],
  controllers: [InstitutionController, PublicBrandingController],
  providers: [
    TenantResolver,
    InstitutionsRepository,
    BrandingAssets,
    BrandingCache,
    GetInstitutionProfile,
    GetBranding,
    UpdateBranding,
    CreateLogoUpload,
    GetPublicBranding,
  ],
  exports: [BrandingCache],
})
export class InstitutionsModule {}
