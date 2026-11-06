import { Module } from '@nestjs/common';

import { PasswordService } from '../../common/auth/password.service';
import { InstitutionsModule } from '../institutions/institutions.module';

import { CreatePlatformAdmin } from './admins/create-platform-admin.use-case';
import { PlatformAuthController } from './auth/platform-auth.controller';
import { PlatformLogin } from './auth/platform-login.use-case';
import { PlatformRefresh } from './auth/platform-refresh.use-case';
import { PlatformSessions } from './auth/platform-sessions';
import { ChangeInstitutionStatus } from './institutions/change-institution-status.use-case';
import { ListInstitutions } from './institutions/list-institutions.use-case';
import { PlatformInstitutionsController } from './institutions/platform-institutions.controller';
import { RegisterInstitution } from './institutions/register-institution.use-case';

/**
 * Platform administration: admin sign-in and tenant (institution) lifecycle. Imports
 * `InstitutionsModule` only for its exported `BrandingCache` (invalidated on suspension).
 */
@Module({
  imports: [InstitutionsModule],
  controllers: [PlatformAuthController, PlatformInstitutionsController],
  providers: [
    PasswordService,
    PlatformSessions,
    PlatformLogin,
    PlatformRefresh,
    CreatePlatformAdmin,
    RegisterInstitution,
    ListInstitutions,
    ChangeInstitutionStatus,
  ],
  exports: [CreatePlatformAdmin],
})
export class PlatformModule {}
