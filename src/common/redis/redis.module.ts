import { once } from 'node:events';

import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Block startup until Redis is reachable: the process is never "ready" without it. */
  async onModuleInit(): Promise<void> {
    if (this.redis.status === 'ready') return;
    await once(this.redis, 'ready');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: Env) =>
        new Redis(config.REDIS_URL, {
          // Fail fast rather than queueing commands forever when Redis is down.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          connectTimeout: 5_000,
          lazyConnect: false,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
