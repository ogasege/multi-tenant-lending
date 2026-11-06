import type { LoggerService } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';

/**
 * A job run on a fixed interval through the @nestjs/schedule registry, never overlapping
 * itself. `stop()` removes the interval and waits for a run in progress, so shutdown never
 * closes the database pools under a running job.
 */
export class PeriodicJob {
  private current: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly job: () => Promise<void>,
    private readonly logger: LoggerService,
  ) {}

  start(registry: SchedulerRegistry, intervalMs: number, runNow: boolean): void {
    registry.addInterval(
      this.name,
      setInterval(() => {
        void this.trigger();
      }, intervalMs),
    );
    if (runNow) void this.trigger();
  }

  /** Runs the job unless it is already running or the job was stopped. */
  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.current ??= this.job()
      .catch((err: unknown) => {
        this.logger.error({ msg: 'periodic job failed', job: this.name, err });
      })
      .finally(() => {
        this.current = undefined;
      });
    return this.current;
  }

  async stop(registry: SchedulerRegistry): Promise<void> {
    this.stopped = true;
    if (registry.doesExist('interval', this.name)) registry.deleteInterval(this.name);
    await this.current;
  }
}
