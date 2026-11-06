import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { Tx } from '../database/database.tokens';
import type { UserRole } from '../database/schema';

import { newRefreshToken } from './refresh-token';
import { type TokenPairDto, toTokenPair } from './token-pair.dto';
import { TokenService } from './token.service';

export interface SessionUser {
  id: string;
  tenantId: string;
  role: UserRole;
}

/**
 * Tenant user sessions: an access token plus a refresh token persisted (hashed) in
 * `refresh_tokens`. Shared by sign-in, refresh rotation and customer self-registration so
 * every path issues sessions identically. Must run inside the tenant's transaction.
 */
@Injectable()
export class TenantSessions {
  constructor(
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  /** Starts a new session; pass `familyId` to continue an existing rotation family. */
  async issue(tx: Tx, user: SessionUser, familyId: string = randomUUID()): Promise<TokenPairDto> {
    const refresh = newRefreshToken(this.config.REFRESH_TOKEN_TTL_DAYS);
    await tx
      .insertInto('refresh_tokens')
      .values({
        tenant_id: user.tenantId,
        user_id: user.id,
        family_id: familyId,
        token_hash: refresh.hash,
        expires_at: refresh.expiresAt,
      })
      .execute();
    const access = this.tokens.issueAccessToken({ kind: 'USER', ...user });
    return toTokenPair(access, refresh);
  }

  /** Revokes every still-valid token of a rotation family (logout / reuse detection). */
  async revokeFamily(tx: Tx, familyId: string): Promise<void> {
    await tx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Revokes all sessions of a user (when the account is disabled or its role changes). */
  async revokeAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
