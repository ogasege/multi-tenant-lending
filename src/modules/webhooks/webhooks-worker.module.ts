import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { SqsModule } from '../../common/aws/sqs';
import { WORKER_CONFIG } from '../../config/worker-config.module';
import type { WorkerEnv } from '../../config/worker-env.schema';
import { PollingLoop } from '../../worker/polling-loop';

import { WebhookDeliveriesRepository } from './infrastructure/webhook-deliveries.repository';
import { WEBHOOK_TARGET_GUARD_PROVIDERS } from './infrastructure/webhook-target-guard';
import { OutboxRelay } from './worker/outbox-relay';
import { WEBHOOK_TLS_CA, WebhookDispatcher } from './worker/webhook-dispatcher';

/**
 * Runs the two loops for the life of the worker process. On shutdown (SIGTERM) both stop
 * polling and finish their in-flight batch BEFORE any pool is closed: Nest calls
 * `beforeApplicationShutdown` ahead of every `onApplicationShutdown` hook.
 */
@Injectable()
export class WebhookLoops implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebhookLoops.name);
  private readonly loops: PollingLoop[];

  constructor(
    relay: OutboxRelay,
    dispatcher: WebhookDispatcher,
    @Inject(WORKER_CONFIG) config: WorkerEnv,
  ) {
    this.loops = [
      new PollingLoop(
        'outbox-relay',
        async () => {
          const r = await relay.relayBatch();
          // A full batch means more rows are probably waiting: go again without sleeping.
          return r.claimed >= config.OUTBOX_BATCH_SIZE ? 'busy' : 'idle';
        },
        config.OUTBOX_POLL_INTERVAL_MS,
        this.logger,
      ),
      new PollingLoop(
        'webhook-dispatcher',
        (signal) => dispatcher.pollOnce(signal),
        // Long polling already waits on the server; this only spaces out error retries.
        1_000,
        this.logger,
      ),
    ];
  }

  onApplicationBootstrap(): void {
    for (const loop of this.loops) loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
  }
}

/**
 * Worker side of webhooks (SPEC §9): the transactional-outbox relay to SQS and the SQS
 * consumer that delivers signed webhooks. Imported only by WorkerModule.
 */
@Module({
  imports: [SqsModule],
  providers: [
    ...WEBHOOK_TARGET_GUARD_PROVIDERS,
    { provide: WEBHOOK_TLS_CA, useValue: null },
    WebhookDeliveriesRepository,
    OutboxRelay,
    WebhookDispatcher,
    WebhookLoops,
  ],
  exports: [OutboxRelay, WebhookDispatcher],
})
export class WebhooksWorkerModule {}
