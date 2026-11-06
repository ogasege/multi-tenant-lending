import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { CommonModule } from './common/common.module';
import { WorkerDatabaseModule } from './common/database/worker-database.module';
import { WorkerConfigModule } from './config/worker-config.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { EndOfDayService } from './modules/operations/application/end-of-day.service';
import { OperationsModule } from './modules/operations/operations.module';
import { WebhooksWorkerModule } from './modules/webhooks/webhooks-worker.module';
import { DirectoryReconcileJob } from './worker/directory-reconcile.job';
import { END_OF_DAY_RUNNER } from './worker/end-of-day/end-of-day.port';
import { EndOfDayScheduler } from './worker/end-of-day/end-of-day.scheduler';

/**
 * Worker composition root (no HTTP server). Shares CommonModule with the API (config, CLS,
 * pino logging, `lending_app` TransactionRunner, Redis, audit/outbox writers) and adds what
 * only the worker holds: the `lending_worker` connection (WORKER_DB, cross-tenant), SQS and
 * the background jobs.
 *
 *   - outbox relay → SQS, and SQS → signed webhook deliveries   (WebhooksWorkerModule)
 *   - tenant directory projection + periodic reconciliation      (DirectoryModule, job)
 *   - end of day per tenant in the tenant's time zone           (EndOfDayScheduler)
 *
 * EOD runs the operations module's `EndOfDayService` through the `END_OF_DAY_RUNNER` port
 * (worker/end-of-day/end-of-day.port.ts), so the scheduler does not depend on lending code.
 */
@Module({
  imports: [
    CommonModule,
    WorkerConfigModule,
    WorkerDatabaseModule,
    ScheduleModule.forRoot(),
    DirectoryModule,
    WebhooksWorkerModule,
    OperationsModule,
  ],
  providers: [
    DirectoryReconcileJob,
    { provide: END_OF_DAY_RUNNER, useExisting: EndOfDayService },
    EndOfDayScheduler,
  ],
})
export class WorkerModule {}
