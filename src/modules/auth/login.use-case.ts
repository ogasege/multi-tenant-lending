import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { isLocked, registerFailedLogin } from '../../common/auth/lockout';
import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import type { TokenPairDto } from '../../common/auth/token-pair.dto';
import type { Tx } from '../../common/database/database.tokens';
import { TenantResolver } from '../../common/database/tenant-resolver';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ForbiddenError, UnauthenticatedError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxWriter } from '../../common/outbox/outbox-writer';

import type { LoginDto } from './auth.dto';

type Outcome = { kind: 'ok'; session: TokenPairDto } | { kind: 'invalid' } | { kind: 'suspended' };

type FailureReason = 'bad_credentials' | 'account_disabled' | 'account_locked';

const invalidCredentials = () =>
  new UnauthenticatedError(ErrorCode.INVALID_CREDENTIALS, 'Invalid institution, email or password');

/**
 * Tenant user (staff or customer) sign-in.
 *  - unknown institution, unknown email, wrong password, disabled AND locked accounts are
 *    indistinguishable: the same 401 INVALID_CREDENTIALS after the same argon2 work (a locked
 *    account refuses even the correct password; the owner is notified out of band through
 *    the `auth.account_locked` audit entry + outbox event);
 *  - 5 consecutive failures lock the account for 15 minutes;
 *  - a suspended institution is reported only to callers who proved valid credentials;
 *  - argon2 runs OUTSIDE any transaction: the user is read without a lock, the password is
 *    verified, and only then a short transaction re-reads the row `FOR UPDATE`, re-checks
 *    the lock and the hash, and updates the failure counter atomically. No row lock or
 *    pooled connection is held for the duration of the (deliberately slow) hash;
 *  - successes and failures of known accounts are audited (with IP and user agent).
 */
@Injectable()
export class Login {
  constructor(
    private readonly resolver: TenantResolver,
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
    private readonly sessions: TenantSessions,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async execute(dto: LoginDto): Promise<TokenPairDto> {
    const institution = await this.resolver.institutionBySlug(dto.institutionSlug);
    if (!institution) {
      await this.passwords.verify(null, dto.password);
      throw invalidCredentials();
    }
    const tenantId = institution.id;

    const candidate = await this.runner.runForTenant(tenantId, (tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'password_hash'])
        .where((eb) => eb(eb.fn('lower', ['email']), '=', dto.email))
        .executeTakeFirst(),
    );
    const valid = await this.passwords.verify(candidate?.password_hash ?? null, dto.password);
    if (!candidate) throw invalidCredentials();

    const outcome = await this.runner.runForTenant<Outcome>(tenantId, async (tx) => {
      const user = await tx
        .selectFrom('users')
        .select(['id', 'role', 'status', 'password_hash', 'failed_login_count', 'locked_until'])
        .where('id', '=', candidate.id)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return { kind: 'invalid' };

      const now = new Date();
      const state = { failedLoginCount: user.failed_login_count, lockedUntil: user.locked_until };
      if (isLocked(state, now)) {
        await this.recordFailure(tx, tenantId, user.id, 'account_locked');
        return { kind: 'invalid' };
      }

      // The hash may have changed (password reset) since it was verified unlocked.
      const credentialsOk = valid && user.password_hash === candidate.password_hash;
      if (!credentialsOk || user.status !== 'ACTIVE') {
        const next = registerFailedLogin(state, now);
        await tx
          .updateTable('users')
          .set({ failed_login_count: next.failedLoginCount, locked_until: next.lockedUntil })
          .where('id', '=', user.id)
          .execute();
        await this.recordFailure(
          tx,
          tenantId,
          user.id,
          credentialsOk ? 'account_disabled' : 'bad_credentials',
        );
        if (isLocked(next, now)) await this.recordLock(tx, tenantId, user.id, next.lockedUntil);
        return { kind: 'invalid' };
      }

      // Only now (valid credentials) is the institution status disclosed.
      if (institution.status !== 'ACTIVE') return { kind: 'suspended' };

      await tx
        .updateTable('users')
        .set({ failed_login_count: 0, locked_until: null })
        .where('id', '=', user.id)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actor: { type: 'USER', id: user.id },
        action: 'auth.login_succeeded',
        entityType: 'user',
        entityId: user.id,
      });
      return {
        kind: 'ok',
        session: await this.sessions.issue(tx, { id: user.id, tenantId, role: user.role }),
      };
    });

    if (outcome.kind === 'invalid') throw invalidCredentials();
    if (outcome.kind === 'suspended') {
      throw new ForbiddenError(
        ErrorCode.INSTITUTION_SUSPENDED,
        'This institution is suspended; sign-in is disabled',
      );
    }
    return outcome.session;
  }

  private recordFailure(
    tx: Tx,
    tenantId: string,
    userId: string,
    reason: FailureReason,
  ): Promise<void> {
    return this.audit.record(tx, {
      tenantId,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: userId,
      after: { reason },
    });
  }

  /** Audit + outbox event: the notification service tells the owner out of band. */
  private async recordLock(
    tx: Tx,
    tenantId: string,
    userId: string,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      tenantId,
      action: 'auth.account_locked',
      entityType: 'user',
      entityId: userId,
      after: { lockedUntil },
    });
    await this.outbox.publish(tx, {
      tenantId,
      type: 'auth.account_locked',
      aggregateType: 'user',
      aggregateId: userId,
      data: { userId, lockedUntil: lockedUntil?.toISOString() ?? null },
    });
  }
}
