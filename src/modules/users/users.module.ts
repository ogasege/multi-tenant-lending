import { Module } from '@nestjs/common';

import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';

import { CreateUser } from './create-user.use-case';
import { ListUsers } from './list-users.use-case';
import { UpdateUser } from './update-user.use-case';
import { UsersController } from './users.controller';

/** Staff user management within an institution (permission `user:manage`). */
@Module({
  controllers: [UsersController],
  providers: [PasswordService, TenantSessions, ListUsers, CreateUser, UpdateUser],
})
export class UsersModule {}
