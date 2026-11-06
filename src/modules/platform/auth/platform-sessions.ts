import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { newRefreshToken } from '../../../common/auth/refresh-token';
import { type TokenPairDto, toTokenPair } from '../../../common/auth/token-pair.dto';
import { TokenService } from '../../../common/auth/token.service';
import type { Tx } from '../../../common/database/database.tokens';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';

/** Platform-admin sessions (aud=platform). Must run inside `asPlatformAuth`. */
@Injectable()
export class PlatformSessions {
  constructor(
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async issue(tx: Tx, adminId: string, familyId: string = randomUUID()): Promise<TokenPairDto> {
    const refresh = newRefreshToken(this.config.REFRESH_TOKEN_TTL_DAYS);
    await tx
      .insertInto('platform_refresh_tokens')
      .values({
        admin_id: adminId,
        family_id: familyId,
        token_hash: refresh.hash,
        expires_at: refresh.expiresAt,
      })
      .execute();
    const access = this.tokens.issueAccessToken({ kind: 'PLATFORM_ADMIN', id: adminId });
    return toTokenPair(access, refresh);
  }

  async revokeFamily(tx: Tx, familyId: string): Promise<void> {
    await tx
      .updateTable('platform_refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
