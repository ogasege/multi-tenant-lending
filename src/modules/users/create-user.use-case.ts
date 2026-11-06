import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { PasswordService } from '../../common/auth/password.service';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ConflictError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxWriter } from '../../common/outbox/outbox-writer';

import { type CreateUserDto, USER_COLUMNS, UserDto } from './user.dto';

/** Creates a staff user in the caller's institution (tenant from the access token only). */
@Injectable()
export class CreateUser {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async execute(tenantId: string, dto: CreateUserDto): Promise<UserDto> {
    const passwordHash = await this.passwords.hash(dto.password);
    return this.runner.run(async (tx) => {
      const existing = await tx
        .selectFrom('users')
        .select('id')
        .where((eb) => eb(eb.fn('lower', ['email']), '=', dto.email))
        .executeTakeFirst();
      if (existing) {
        throw new ConflictError(ErrorCode.DUPLICATE, 'A user with this email already exists');
      }

      const row = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email: dto.email,
          full_name: dto.fullName.trim(),
          role: dto.role,
          password_hash: passwordHash,
        })
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const user = UserDto.from(row);

      await this.audit.record(tx, {
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        after: user,
      });
      await this.outbox.publish(tx, {
        type: 'user.created',
        aggregateType: 'user',
        aggregateId: user.id,
        data: { userId: user.id, role: user.role },
      });
      return user;
    });
  }
}
