import { Injectable } from '@nestjs/common';

import { isLocked, registerFailedLogin } from '../../../common/auth/lockout';
import { PasswordService } from '../../../common/auth/password.service';
import type { TokenPairDto } from '../../../common/auth/token-pair.dto';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { UnauthenticatedError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';

import { PlatformSessions } from './platform-sessions';

/**
 * Platform admin sign-in. Unknown email, wrong password, disabled AND locked accounts all
 * yield the same 401 INVALID_CREDENTIALS after the same argon2 work (a locked account also
 * refuses the correct password). argon2 runs outside any transaction: the admin row is read
 * unlocked, the password verified, then a short transaction re-reads it `FOR UPDATE`,
 * re-checks the lock and the hash and updates the failure counter atomically. Failure
 * counters are committed before the error is raised (the transaction returns an outcome).
 */
@Injectable()
export class PlatformLogin {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
    private readonly sessions: PlatformSessions,
  ) {}

  async execute(email: string, password: string): Promise<TokenPairDto> {
    const candidate = await this.runner.asPlatformAuth((tx) =>
      tx
        .selectFrom('platform_admins')
        .select(['id', 'password_hash'])
        .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
        .executeTakeFirst(),
    );
    const valid = await this.passwords.verify(candidate?.password_hash ?? null, password);

    const session = candidate
      ? await this.runner.asPlatformAuth(async (tx) => {
          const admin = await tx
            .selectFrom('platform_admins')
            .select(['id', 'password_hash', 'status', 'failed_login_count', 'locked_until'])
            .where('id', '=', candidate.id)
            .forUpdate()
            .executeTakeFirst();
          if (!admin) return null;

          const now = new Date();
          const state = {
            failedLoginCount: admin.failed_login_count,
            lockedUntil: admin.locked_until,
          };
          if (isLocked(state, now)) return null;

          const credentialsOk = valid && admin.password_hash === candidate.password_hash;
          if (!credentialsOk || admin.status !== 'ACTIVE') {
            const next = registerFailedLogin(state, now);
            await tx
              .updateTable('platform_admins')
              .set({ failed_login_count: next.failedLoginCount, locked_until: next.lockedUntil })
              .where('id', '=', admin.id)
              .execute();
            return null;
          }

          await tx
            .updateTable('platform_admins')
            .set({ failed_login_count: 0, locked_until: null })
            .where('id', '=', admin.id)
            .execute();
          return this.sessions.issue(tx, admin.id);
        })
      : null;

    if (!session) {
      throw new UnauthenticatedError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
    }
    return session;
  }
}
