import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS } from '../../../common/redis/redis.module';
import type { DirectoryEntry } from '../domain/directory-entry';

/** Seconds a directory lookup is cached (SPEC §4.1). */
export const DIRECTORY_CACHE_TTL_SECONDS = 60;

/**
 * Seconds an unknown slug is remembered. Short, so a freshly registered tenant becomes
 * routable quickly, but enough to stop slug enumeration from hammering DynamoDB.
 */
export const DIRECTORY_NEGATIVE_TTL_SECONDS = 10;

/** `null` = cached miss; `undefined` = not cached. */
export type Cached<T> = T | null | undefined;

const slugKey = (slug: string): string => `directory:v1:slug:${slug}`;

/**
 * Cache-aside store in front of the tenant directory. Redis is an optimisation, not a
 * dependency: failures are logged and callers fall back to DynamoDB.
 */
@Injectable()
export class DirectoryCache {
  private readonly logger = new Logger(DirectoryCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  getEntry(slug: string): Promise<Cached<DirectoryEntry>> {
    return this.read<DirectoryEntry>(slugKey(slug));
  }

  setEntry(slug: string, entry: DirectoryEntry | null): Promise<void> {
    const ttl = entry ? DIRECTORY_CACHE_TTL_SECONDS : DIRECTORY_NEGATIVE_TTL_SECONDS;
    return this.write(slugKey(slug), entry, ttl);
  }

  async invalidate(slug: string): Promise<void> {
    try {
      await this.redis.del(slugKey(slug));
    } catch (err) {
      this.logger.warn(`Directory cache invalidation failed for ${slug}: ${String(err)}`);
    }
  }

  private async read<T>(key: string): Promise<Cached<T>> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T | null);
    } catch (err) {
      this.logger.warn(`Directory cache read failed: ${String(err)}`);
      return undefined;
    }
  }

  private async write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Directory cache write failed: ${String(err)}`);
    }
  }
}
