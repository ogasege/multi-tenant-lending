import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { hashRefreshToken } from '../../common/auth/refresh-token';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import type { TokenPairDto } from '../../common/auth/token-pair.dto';
import { TenantResolver } from '../../common/database/tenant-resolver';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ForbiddenError, UnauthenticatedError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';

type Outcome = { kind: 'ok'; session: TokenPairDto } | { kind: 'invalid' } | { kind: 'suspended' };

const invalidRefreshToken = () =>
  new UnauthenticatedError(
    ErrorCode.INVALID_REFRESH_TOKEN,
    'The refresh token is invalid, expired or revoked',
  );

/**
 * Refresh-token rotation (SPEC §5, RFC 9700 §4.14.2). Each token is single use; the new token
 * joins the same family. Presenting a token that was already rotated or revoked means it
 * leaked, so the whole family is revoked (attacker and victim must both sign in again) and
 * the event is audited. Disabled users and suspended institutions cannot refresh.
 */
@Injectable()
export class Refresh {
  constructor(
    private readonly resolver: TenantResolver,
    private readonly runner: TransactionRunner,
    private readonly sessions: TenantSessions,
    private readonly audit: AuditWriter,
  ) {}

  async execute(refreshToken: string): Promise<TokenPairDto> {
    const hash = hashRefreshToken(refreshToken);
    const tenantId = await this.resolver.refreshTokenTenant(hash);
    if (!tenantId) throw invalidRefreshToken();

    const outcome = await this.runner.runForTenant<Outcome>(tenantId, async (tx) => {
      const token = await tx
        .selectFrom('refresh_tokens as t')
        .innerJoin('users as u', (join) =>
          join.onRef('u.tenant_id', '=', 't.tenant_id').onRef('u.id', '=', 't.user_id'),
        )
        .select(['t.id', 't.user_id', 't.family_id', 't.expires_at', 't.used_at', 't.revoked_at'])
        .select(['u.role', 'u.status as user_status'])
        .where('t.token_hash', '=', hash)
        .forUpdate('t')
        .executeTakeFirst();
      if (!token) return { kind: 'invalid' };

      if (token.used_at || token.revoked_at) {
        await this.sessions.revokeFamily(tx, token.family_id);
        await this.audit.record(tx, {
          tenantId,
          action: 'auth.refresh_token_reuse_detected',
          entityType: 'user',
          entityId: token.user_id,
          after: { familyId: token.family_id, familyRevoked: true },
        });
        return { kind: 'invalid' };
      }

      const now = new Date();
      if (token.expires_at <= now) return { kind: 'invalid' };
      if (token.user_status !== 'ACTIVE') {
        await this.sessions.revokeFamily(tx, token.family_id);
        return { kind: 'invalid' };
      }

      const institution = await tx
        .selectFrom('institutions')
        .select('status')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      if (institution?.status !== 'ACTIVE') {
        await this.sessions.revokeFamily(tx, token.family_id);
        return { kind: 'suspended' };
      }

      await tx
        .updateTable('refresh_tokens')
        .set({ used_at: now })
        .where('id', '=', token.id)
        .execute();
      return {
        kind: 'ok',
        session: await this.sessions.issue(
          tx,
          { id: token.user_id, tenantId, role: token.role },
          token.family_id,
        ),
      };
    });

    if (outcome.kind === 'suspended') {
      throw new ForbiddenError(ErrorCode.INSTITUTION_SUSPENDED, 'This institution is suspended');
    }
    if (outcome.kind === 'invalid') throw invalidRefreshToken();
    return outcome.session;
  }
}
