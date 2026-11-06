import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import { APP_DB, type Db } from './database.tokens';
import { createKysely } from './kysely.factory';
import { TransactionRunner } from './transaction-runner';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * API-process database access: ONLY the `lending_app` role (RLS enforced). The worker process
 * registers its own `lending_worker` connection in WorkerModule; the API never holds it.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_DB,
      inject: [APP_CONFIG],
      useFactory: (c: Env): Db =>
        createKysely({
          host: c.DATABASE_HOST,
          port: c.DATABASE_PORT,
          database: c.DATABASE_NAME,
          user: c.DATABASE_APP_USER,
          password: c.DATABASE_APP_PASSWORD,
          ssl: c.DATABASE_SSL,
          poolMax: c.DATABASE_POOL_MAX,
          applicationName: 'lending-api',
        }),
    },
    TransactionRunner,
    DatabaseLifecycle,
  ],
  // APP_DB is intentionally NOT exported: all access goes through TransactionRunner.
  exports: [TransactionRunner],
})
export class DatabaseModule {}
