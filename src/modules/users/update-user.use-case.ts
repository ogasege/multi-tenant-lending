import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { AccessRevocations } from '../../common/auth/access-revocations';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { OutboxWriter } from '../../common/outbox/outbox-writer';

import { type UpdateUserDto, USER_COLUMNS, UserDto } from './user.dto';

/**
 * Changes a staff user's role and/or status. Administrators cannot disable or re-role
 * themselves (prevents an institution locking out its last admin by accident). Customer
 * accounts are not reachable here (404).
 *
 * ANY role change or disable takes effect immediately: all the user's refresh tokens are
 * revoked and their outstanding access tokens are invalidated through `AccessRevocations`
 * (written inside the transaction, so if Redis is unavailable the change is rolled back and
 * reported instead of leaving a stale, still-privileged token alive). The user signs in again
 * and gets a token with the new role.
 */
@Injectable()
export class UpdateUser {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly sessions: TenantSessions,
    private readonly revocations: AccessRevocations,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  execute(actorId: string, userId: string, dto: UpdateUserDto): Promise<UserDto> {
    if (dto.role === undefined && dto.status === undefined) {
      throw new ValidationError('Provide role and/or status');
    }
    if (userId === actorId) {
      throw new ForbiddenError(undefined, 'You cannot change your own role or status');
    }

    return this.runner.run(async (tx) => {
      const current = await tx
        .selectFrom('users')
        .select(USER_COLUMNS)
        .where('id', '=', userId)
        .where('role', '!=', 'CUSTOMER')
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('User', userId);

      const row = await tx
        .updateTable('users')
        .set({ role: dto.role ?? current.role, status: dto.status ?? current.status })
        .where('id', '=', userId)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const roleChanged = row.role !== current.role;
      const disabled = row.status === 'DISABLED' && current.status !== 'DISABLED';
      if (roleChanged || disabled) {
        await this.sessions.revokeAllForUser(tx, userId);
        await this.revocations.revokePrincipal(userId);
      }

      await this.audit.record(tx, {
        action: 'user.updated',
        entityType: 'user',
        entityId: userId,
        before: { role: current.role, status: current.status },
        after: { role: row.role, status: row.status },
      });
      await this.outbox.publish(tx, {
        type: 'user.updated',
        aggregateType: 'user',
        aggregateId: userId,
        data: { userId, role: row.role, status: row.status },
      });
      return UserDto.from(row);
    });
  }
}
