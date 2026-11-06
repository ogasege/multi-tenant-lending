import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { WORKER_CONFIG } from '../../config/worker-config.module';
import type { WorkerEnv } from '../../config/worker-env.schema';

import { type Db, WORKER_DB } from './database.tokens';
import { createKysely } from './kysely.factory';

@Injectable()
class WorkerDatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(WORKER_DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * Worker-process ONLY: Kysely bound to `lending_worker`, whose `worker_all` RLS policy grants
 * cross-tenant access (SPEC §4). Used solely for jobs that must see every tenant (outbox
 * relay, EOD tenant iteration); per-tenant work still goes through `TransactionRunner` on
 * `lending_app`. Every query on this handle must filter by tenant explicitly when it acts
 * on one tenant's rows.
 */
@Global()
@Module({
  providers: [
    {
      provide: WORKER_DB,
      inject: [WORKER_CONFIG],
      useFactory: (c: WorkerEnv): Db =>
        createKysely({
          host: c.DATABASE_HOST,
          port: c.DATABASE_PORT,
          database: c.DATABASE_NAME,
          user: c.DATABASE_WORKER_USER,
          password: c.DATABASE_WORKER_PASSWORD,
          ssl: c.DATABASE_SSL,
          poolMax: c.DATABASE_WORKER_POOL_MAX,
          applicationName: 'lending-worker',
        }),
    },
    WorkerDatabaseLifecycle,
  ],
  exports: [WORKER_DB],
})
export class WorkerDatabaseModule {}
