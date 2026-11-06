import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { REDIS } from '../redis/redis.module';

const principalKey = (id: string): string => `auth:v1:valid-after:principal:${id}`;
const tenantKey = (id: string): string => `auth:v1:valid-after:tenant:${id}`;
const suspendedKey = (id: string): string => `auth:v1:suspended:tenant:${id}`;

export type AccessState = 'valid' | 'revoked' | 'suspended';

/**
 * Immediate invalidation of stateless access tokens (OWASP ASVS V3.3): refresh tokens are
 * revoked in Postgres, but an access token stays verifiable until it expires (≤ 15 min). Each
 * request therefore also checks, with ONE Redis `MGET`:
 *
 * - a per-principal "valid-after" epoch (ms), set when a user's role or status changes:
 *   tokens issued before it are rejected (demotion and disabling take effect at once);
 * - a per-tenant "valid-after" epoch, set on suspension, so tokens from before a suspension
 *   stay dead even if the tenant is reactivated within their lifetime;
 * - a per-tenant suspended flag (cleared on reactivation).
 *
 * Every key expires after the access-token lifetime (+60 s skew): by then every token it
 * could reject has expired, and new tokens are only issued after the database checks (role,
 * status, institution status) that sign-in and refresh already perform.
 */
@Injectable()
export class AccessRevocations {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: Env,
  ) {
    this.ttlSeconds = config.JWT_ACCESS_TTL_SECONDS + 60;
  }

  /** Rejects every access token of `principalId` issued before now. */
  revokePrincipal(principalId: string, at: Date = new Date()): Promise<void> {
    return this.write(async () => {
      await this.redis.set(principalKey(principalId), String(at.getTime()), 'EX', this.ttlSeconds);
    });
  }

  /** Marks a tenant suspended and rejects every token of it issued before now. */
  suspendTenant(tenantId: string, at: Date = new Date()): Promise<void> {
    return this.write(async () => {
      const results = await this.redis
        .multi()
        .set(tenantKey(tenantId), String(at.getTime()), 'EX', this.ttlSeconds)
        .set(suspendedKey(tenantId), '1', 'EX', this.ttlSeconds)
        .exec();
      const failed = results?.find(([err]) => err !== null)?.[0];
      if (!results || failed) throw failed ?? new Error('Redis transaction aborted');
    });
  }

  /** Clears the suspended flag (tokens from before the suspension stay revoked). */
  reactivateTenant(tenantId: string): Promise<void> {
    return this.write(async () => {
      await this.redis.del(suspendedKey(tenantId));
    });
  }

  /** One round trip; throws when Redis is unavailable (the caller decides open/closed). */
  async check(principalId: string, tenantId: string, issuedAtMs: number): Promise<AccessState> {
    const [principalAfter, tenantAfter, suspended] = await this.redis.mget(
      principalKey(principalId),
      tenantKey(tenantId),
      suspendedKey(tenantId),
    );
    if (suspended) return 'suspended';
    const revokedBefore = Math.max(Number(principalAfter ?? 0), Number(tenantAfter ?? 0));
    return issuedAtMs < revokedBefore ? 'revoked' : 'valid';
  }

  /**
   * Writes are made inside the caller's transaction: a Redis failure aborts the business
   * change (503) rather than committing a revocation that is not enforced.
   */
  private async write(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      throw new AppError(
        503,
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'Session revocation is temporarily unavailable; retry shortly',
      );
    }
  }
}
