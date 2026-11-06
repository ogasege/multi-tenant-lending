import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS } from '../../../common/redis/redis.module';

/** What the public branding endpoint returns (and what is cached). No tenant id. */
export interface PublicBranding {
  slug: string;
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  locale: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
}

/**
 * Seconds a public branding document is cached. Kept far below the 1 h lifetime of the
 * presigned logo URL inside it, so a cached URL is always valid for at least 59 minutes.
 */
export const PUBLIC_BRANDING_TTL_SECONDS = 60;

const key = (slug: string): string => `branding:public:v1:${slug}`;

/**
 * Cache-aside store for public branding, keyed by slug. Redis is an optimisation here, not
 * a dependency: read/write failures are logged and the caller falls back to the database.
 *
 * Invalidation runs after the updating transaction commits. A reader that loaded the old
 * row just before the commit can still re-populate the old value; the short TTL bounds that
 * staleness to 60 s.
 */
@Injectable()
export class BrandingCache {
  private readonly logger = new Logger(BrandingCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(slug: string): Promise<PublicBranding | undefined> {
    try {
      const raw = await this.redis.get(key(slug));
      return raw ? (JSON.parse(raw) as PublicBranding) : undefined;
    } catch (err) {
      this.logger.warn(`Branding cache read failed: ${String(err)}`);
      return undefined;
    }
  }

  async set(value: PublicBranding): Promise<void> {
    try {
      await this.redis.set(
        key(value.slug),
        JSON.stringify(value),
        'EX',
        PUBLIC_BRANDING_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`Branding cache write failed: ${String(err)}`);
    }
  }

  /** Drop the cached document for `slug` (call after branding or institution status changes). */
  async invalidate(slug: string): Promise<void> {
    try {
      await this.redis.del(key(slug));
    } catch (err) {
      this.logger.warn(`Branding cache invalidation failed for ${slug}: ${String(err)}`);
    }
  }
}
