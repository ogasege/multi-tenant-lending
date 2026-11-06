import { setTimeout as sleep } from 'node:timers/promises';

import type { LoggerService } from '@nestjs/common';

/** What one iteration did: `busy` loops again at once, `idle` waits for the poll interval. */
export type TickResult = 'busy' | 'idle';

/**
 * A sequential polling loop with graceful shutdown. `stop()` stops scheduling new
 * iterations, cancels the idle wait (and whatever the tick passes the signal to, e.g. an SQS
 * long poll), then waits for the in-flight iteration to finish, so a batch that was picked
 * up is always completed before the process closes its pools.
 */
export class PollingLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly name: string,
    private readonly tick: (signal: AbortSignal) => Promise<TickResult>,
    private readonly idleDelayMs: number,
    private readonly logger: LoggerService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    this.logger.log({ msg: 'polling loop started', loop: this.name });
    while (this.running) {
      let result: TickResult = 'idle';
      try {
        result = await this.tick(this.abort.signal);
      } catch (err) {
        if (!this.abort.signal.aborted) {
          this.logger.error({ msg: 'polling iteration failed', loop: this.name, err });
        }
      }
      if (result === 'idle' && !this.abort.signal.aborted) {
        await sleep(this.idleDelayMs, undefined, { signal: this.abort.signal }).catch(() => {
          // Aborted by stop(): fall through and exit the loop.
        });
      }
    }
    this.logger.log({ msg: 'polling loop stopped', loop: this.name });
  }
}
