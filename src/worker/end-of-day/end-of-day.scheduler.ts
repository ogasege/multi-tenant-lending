import { randomUUID } from 'node:crypto';

import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../../common/context/request-context';
import { type Db, WORKER_DB } from '../../common/database/database.tokens';
import { REDIS } from '../../common/redis/redis.module';
import { WORKER_CONFIG } from '../../config/worker-config.module';
import type { WorkerEnv } from '../../config/worker-env.schema';
import { PeriodicJob } from '../periodic-job';

import { END_OF_DAY_RUNNER, type EndOfDayRunner } from './end-of-day.port';
import { dueBusinessDate, parseLocalTime } from './local-clock';

/**
 * The run lock's lease. It is renewed every third of it while the run is in progress, so a
 * long run of a large book keeps its lock, while a crashed worker's lock lapses quickly.
 */
export const LOCK_TTL_MS = 2 * 60_000;
const LOCK_RENEW_EVERY_MS = LOCK_TTL_MS / 3;
/** Completion markers only need to outlive the day they describe (plus DST slack). */
const DONE_TTL_SECONDS = 3 * 24 * 3600;

/** Deletes the lock only if we still hold it. */
export const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Extends the lock's lease only if we still hold it (1 = renewed, 0 = lost). */
export const RENEW_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface EndOfDayTickSummary {
  due: number;
  /** Completed runs (date marked done). */
  ran: number;
  /** Already done, or another worker holds the run lock. */
  skipped: number;
  /** Runs that left busy loans or per-item failures behind: retried on the next tick. */
  incomplete: number;
  failed: number;
}

type RunOutcome = 'ran' | 'skipped' | 'incomplete' | 'failed';

/**
 * Schedules end of day per tenant in the tenant's OWN time zone: every
 * `EOD_CHECK_INTERVAL_SECONDS` it lists active institutions (cross-tenant, `lending_worker`)
 * and, for each one whose local clock has passed `EOD_RUN_AT_LOCAL_TIME`, runs EOD for the
 * PREVIOUS local date (close of day: a business date is closed once it is over) until it
 * completes. "Once" holds across worker tasks: a Redis lock (SET NX PX, lease renewed while
 * the run lasts) serialises runs, and a completion marker — re-checked after taking the lock,
 * so a run that finished between our check and our lock is not repeated — skips dates
 * already done; the EOD service itself is idempotent per (tenant, asOf) as the last line of
 * defence. A date is marked done only when the run left nothing behind (no busy loan
 * skipped, no loan or approval failed); otherwise, like a failed run, it is retried on the
 * next tick. A worker that was down for longer catches up on its next tick for the latest
 * closed date only; earlier dates are the EOD service's catch-up concern.
 */
@Injectable()
export class EndOfDayScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(EndOfDayScheduler.name);
  private readonly job: PeriodicJob;
  private readonly runAtMinute: number;

  constructor(
    @Inject(WORKER_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WORKER_CONFIG) private readonly config: WorkerEnv,
    private readonly registry: SchedulerRegistry,
    private readonly cls: ClsService<RequestContextStore>,
    @Inject(END_OF_DAY_RUNNER) private readonly runner: EndOfDayRunner,
  ) {
    this.runAtMinute = parseLocalTime(config.EOD_RUN_AT_LOCAL_TIME);
    this.job = new PeriodicJob(
      'end-of-day',
      async () => {
        await this.tick();
      },
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.config.EOD_SCHEDULER_ENABLED) {
      this.logger.warn({ msg: 'end-of-day scheduling disabled (EOD_SCHEDULER_ENABLED=false)' });
      return;
    }
    this.job.start(this.registry, this.config.EOD_CHECK_INTERVAL_SECONDS * 1000, true);
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.job.stop(this.registry);
  }

  /** One scheduling pass over every active institution. */
  async tick(now: Date = new Date()): Promise<EndOfDayTickSummary> {
    const summary: EndOfDayTickSummary = { due: 0, ran: 0, skipped: 0, incomplete: 0, failed: 0 };

    const institutions = await this.db
      .selectFrom('institutions')
      .select(['id', 'timezone'])
      .where('status', '=', 'ACTIVE')
      .orderBy('id')
      .execute();

    for (const { id: tenantId, timezone } of institutions) {
      let asOf: string | undefined;
      try {
        asOf = dueBusinessDate(now, timezone, this.runAtMinute);
      } catch (err) {
        this.logger.error({ msg: 'invalid institution time zone', tenantId, timezone, err });
        summary.failed += 1;
        continue;
      }
      if (!asOf) continue;
      summary.due += 1;
      const outcome = await this.runOnce(tenantId, asOf);
      summary[outcome] += 1;
    }
    if (summary.due > 0) this.logger.log({ msg: 'end-of-day pass', ...summary });
    return summary;
  }

  private async runOnce(tenantId: string, asOf: string): Promise<RunOutcome> {
    const doneKey = `eod:done:${tenantId}:${asOf}`;
    const lockKey = `eod:lock:${tenantId}:${asOf}`;
    if (await this.redis.exists(doneKey)) return 'skipped';
    const token = randomUUID();
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') return 'skipped';
    const renewal = setInterval(() => {
      void this.renewLock(lockKey, token, tenantId, asOf);
    }, LOCK_RENEW_EVERY_MS);
    try {
      // Another worker may have completed the run between our check and our lock.
      if (await this.redis.exists(doneKey)) return 'skipped';
      const started = Date.now();
      // A job context, like a request's: the tenant is pinned for TransactionRunner.run and
      // the audit trail records a SYSTEM actor with a correlation id.
      const outcome = await this.cls.run(() => {
        this.cls.set('requestId', `eod-${tenantId.slice(0, 8)}-${asOf}`);
        this.cls.set('tenantId', tenantId);
        return this.runner.runForTenant(tenantId, asOf);
      });
      const leftBehind =
        outcome.loansSkipped + outcome.loansFailed.length + outcome.applicationsFailed.length;
      const log = { tenantId, asOf, durationMs: Date.now() - started };
      if (leftBehind > 0) {
        this.logger.warn({
          msg: 'end of day incomplete; retrying next tick',
          ...log,
          loansSkipped: outcome.loansSkipped,
          loansFailed: outcome.loansFailed.length,
          applicationsFailed: outcome.applicationsFailed.length,
        });
        return 'incomplete';
      }
      await this.redis.set(doneKey, new Date().toISOString(), 'EX', DONE_TTL_SECONDS);
      this.logger.log({ msg: 'end of day completed', ...log });
      return 'ran';
    } catch (err) {
      this.logger.error({ msg: 'end of day failed; retrying next tick', tenantId, asOf, err });
      return 'failed';
    } finally {
      clearInterval(renewal);
      await this.redis.eval(RELEASE_LOCK, 1, lockKey, token);
    }
  }

  private async renewLock(
    lockKey: string,
    token: string,
    tenantId: string,
    asOf: string,
  ): Promise<void> {
    try {
      const renewed = await this.redis.eval(RENEW_LOCK, 1, lockKey, token, String(LOCK_TTL_MS));
      if (renewed !== 1) {
        // The lease lapsed (e.g. a long Redis outage): another worker may start the same run.
        // Harmless — EOD is idempotent per (tenant, asOf) — but worth knowing about.
        this.logger.warn({ msg: 'end-of-day lock lost during the run', tenantId, asOf });
      }
    } catch (err) {
      this.logger.warn({ msg: 'end-of-day lock renewal failed', tenantId, asOf, err });
    }
  }
}
