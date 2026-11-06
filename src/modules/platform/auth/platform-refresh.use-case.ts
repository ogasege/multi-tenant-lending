import { Injectable } from '@nestjs/common';

import { hashRefreshToken } from '../../../common/auth/refresh-token';
import type { TokenPairDto } from '../../../common/auth/token-pair.dto';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { UnauthenticatedError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';

import { PlatformSessions } from './platform-sessions';

/**
 * Refresh-token rotation for platform admins (RFC 9700 §4.14.2): each token is single use.
 * Presenting a token that was already rotated or revoked means it leaked (attacker and
 * legitimate client both hold it), so the whole family is revoked and both must sign in again.
 */
@Injectable()
export class PlatformRefresh {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly sessions: PlatformSessions,
  ) {}

  async execute(refreshToken: string): Promise<TokenPairDto> {
    const session = await this.runner.asPlatformAuth(async (tx) => {
      const token = await tx
        .selectFrom('platform_refresh_tokens as t')
        .innerJoin('platform_admins as a', 'a.id', 't.admin_id')
        .select(['t.id', 't.admin_id', 't.family_id', 't.expires_at', 't.used_at', 't.revoked_at'])
        .select('a.status as admin_status')
        .where('t.token_hash', '=', hashRefreshToken(refreshToken))
        .forUpdate('t')
        .executeTakeFirst();
      if (!token) return null;

      const now = new Date();
      if (token.used_at || token.revoked_at || token.admin_status !== 'ACTIVE') {
        await this.sessions.revokeFamily(tx, token.family_id);
        return null;
      }
      if (token.expires_at <= now) return null;

      await tx
        .updateTable('platform_refresh_tokens')
        .set({ used_at: now })
        .where('id', '=', token.id)
        .execute();
      return this.sessions.issue(tx, token.admin_id, token.family_id);
    });

    if (!session) {
      throw new UnauthenticatedError(
        ErrorCode.INVALID_REFRESH_TOKEN,
        'The refresh token is invalid, expired or revoked',
      );
    }
    return session;
  }
}
