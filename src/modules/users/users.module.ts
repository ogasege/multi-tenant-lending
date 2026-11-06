import { Module } from '@nestjs/common';

import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';

import { CreateUser } from './create-user.use-case';
import { GetMe } from './get-me.use-case';
import { ListUsers } from './list-users.use-case';
import { MeController } from './me.controller';
import { UpdateUser } from './update-user.use-case';
import { UsersController } from './users.controller';

/**
 * Staff user management within an institution (permission `user:manage`) and the caller's
 * own identity (`GET /v1/me`, any principal).
 */
@Module({
  controllers: [UsersController, MeController],
  providers: [PasswordService, TenantSessions, ListUsers, CreateUser, UpdateUser, GetMe],
})
export class UsersModule {}
