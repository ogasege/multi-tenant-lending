import { Module } from '@nestjs/common';

import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import { TenantResolver } from '../../common/database/tenant-resolver';

import { AuthController } from './auth.controller';
import { Login } from './login.use-case';
import { Logout } from './logout.use-case';
import { Refresh } from './refresh.use-case';

/** Tenant user authentication: sign-in, refresh-token rotation, sign-out. */
@Module({
  controllers: [AuthController],
  providers: [PasswordService, TenantSessions, TenantResolver, Login, Refresh, Logout],
})
export class AuthModule {}
