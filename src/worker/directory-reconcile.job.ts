import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { WORKER_CONFIG } from '../config/worker-config.module';
import type { WorkerEnv } from '../config/worker-env.schema';
import { DirectoryReconciler } from '../modules/directory/application/directory-reconciler';

import { PeriodicJob } from './periodic-job';

/**
 * Reconciles the global tenant directory with this cell's institutions at start-up and every
 * `DIRECTORY_RECONCILE_INTERVAL_MINUTES`. It repairs projections the per-event path missed
 * (e.g. a DynamoDB outage) and backfills tenants registered before the directory existed.
 */
@Injectable()
export class DirectoryReconcileJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(DirectoryReconcileJob.name);
  private readonly job: PeriodicJob;

  constructor(
    reconciler: DirectoryReconciler,
    private readonly registry: SchedulerRegistry,
    @Inject(WORKER_CONFIG) private readonly config: WorkerEnv,
  ) {
    this.job = new PeriodicJob(
      'directory-reconcile',
      async () => {
        const summary = await reconciler.projectPendingInstitutions();
        this.logger.log({ msg: 'tenant directory reconciled', ...summary });
      },
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    this.job.start(this.registry, this.config.DIRECTORY_RECONCILE_INTERVAL_MINUTES * 60_000, true);
  }

  /** For tests and operators: run a reconciliation now (joins one already running). */
  runNow(): Promise<void> {
    return this.job.trigger();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.job.stop(this.registry);
  }
}
