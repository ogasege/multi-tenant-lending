import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { hashRefreshToken } from '../../common/auth/refresh-token';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import { TenantResolver } from '../../common/database/tenant-resolver';
import { TransactionRunner } from '../../common/database/transaction-runner';

/**
 * Ends a session by revoking the refresh token's whole family (RFC 7009 semantics: the
 * refresh token itself is the credential, and an unknown token is not an error, so the
 * endpoint reveals nothing about token validity). Access tokens expire within 15 minutes.
 * A sign-out of a known session is audited (actor = the session's user).
 */
@Injectable()
export class Logout {
  constructor(
    private readonly resolver: TenantResolver,
    private readonly runner: TransactionRunner,
    private readonly sessions: TenantSessions,
    private readonly audit: AuditWriter,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    const hash = hashRefreshToken(refreshToken);
    const tenantId = await this.resolver.refreshTokenTenant(hash);
    if (!tenantId) return;
    await this.runner.runForTenant(tenantId, async (tx) => {
      const token = await tx
        .selectFrom('refresh_tokens')
        .select(['family_id', 'user_id'])
        .where('token_hash', '=', hash)
        .executeTakeFirst();
      if (!token) return;
      await this.sessions.revokeFamily(tx, token.family_id);
      await this.audit.record(tx, {
        tenantId,
        actor: { type: 'USER', id: token.user_id },
        action: 'auth.logout',
        entityType: 'user',
        entityId: token.user_id,
        after: { familyId: token.family_id },
      });
    });
  }
}
