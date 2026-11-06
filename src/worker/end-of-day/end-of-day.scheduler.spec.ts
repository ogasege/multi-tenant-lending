import { Logger } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import type { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../../common/context/request-context';
import type { Db } from '../../common/database/database.tokens';
import type { WorkerEnv } from '../../config/worker-env.schema';

import type { EndOfDayOutcome, EndOfDayRunner } from './end-of-day.port';
import { EndOfDayScheduler, LOCK_TTL_MS, RELEASE_LOCK, RENEW_LOCK } from './end-of-day.scheduler';

const TENANT = '0b7c1d6e-9a43-4c1e-8d2f-5a6b7c8d9e0f';
// 12:00 UTC on 6 Nov = 13:00 in Lagos: EOD for the previous date (5 Nov) is due.
const NOW = new Date('2026-11-06T12:00:00Z');
const DONE = `eod:done:${TENANT}:2026-11-05`;
const LOCK = `eod:lock:${TENANT}:2026-11-05`;

/** In-memory stand-in for the handful of Redis commands the scheduler uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly pexpires: number[] = [];
  /** Called before every EXISTS; lets a test simulate another worker finishing. */
  onExists: (key: string, call: number) => void = () => undefined;
  private existsCalls = 0;

  exists(key: string): Promise<number> {
    this.onExists(key, ++this.existsCalls);
    return Promise.resolve(this.store.has(key) ? 1 : 0);
  }

  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  eval(script: string, _keys: number, key: string, token: string, ttl?: string): Promise<number> {
    if (this.store.get(key) !== token) return Promise.resolve(0);
    if (script === RELEASE_LOCK) this.store.delete(key);
    else if (script === RENEW_LOCK) this.pexpires.push(Number(ttl));
    else throw new Error('unexpected script');
    return Promise.resolve(1);
  }
}

const complete: EndOfDayOutcome = { loansSkipped: 0, loansFailed: [], applicationsFailed: [] };

function setup(run: EndOfDayRunner['runForTenant']) {
  const redis = new FakeRedis();
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            execute: () => Promise.resolve([{ id: TENANT, timezone: 'Africa/Lagos' }]),
          }),
        }),
      }),
    }),
  };
  const cls = { run: <T>(fn: () => T): T => fn(), set: () => undefined };
  const runner = { runForTenant: vi.fn(run) };
  const scheduler = new EndOfDayScheduler(
    db as unknown as Db,
    redis as unknown as Redis,
    { EOD_RUN_AT_LOCAL_TIME: '00:05' } as WorkerEnv,
    {} as SchedulerRegistry,
    cls as unknown as ClsService<RequestContextStore>,
    runner,
  );
  return { redis, runner, scheduler };
}

describe('EndOfDayScheduler', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the previous local date, marks it done and releases the lock', async () => {
    const { redis, runner, scheduler } = setup(() => Promise.resolve(complete));
    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ due: 1, ran: 1 });
    expect(runner.runForTenant).toHaveBeenCalledExactlyOnceWith(TENANT, '2026-11-05');
    expect(redis.store.has(DONE)).toBe(true);
    expect(redis.store.has(LOCK)).toBe(false);

    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ ran: 0, skipped: 1 });
    expect(runner.runForTenant).toHaveBeenCalledOnce();
  });

  it.each<[string, EndOfDayOutcome]>([
    ['a busy loan was skipped', { ...complete, loansSkipped: 1 }],
    ['a loan failed', { ...complete, loansFailed: ['l-1'] }],
    ['an approval expiry failed', { ...complete, applicationsFailed: ['a-1'] }],
  ])('does not mark the date done when %s, and retries next tick', async (_case, outcome) => {
    const { redis, runner, scheduler } = setup(() => Promise.resolve(outcome));
    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ ran: 0, incomplete: 1 });
    expect(redis.store.has(DONE)).toBe(false);
    expect(redis.store.has(LOCK)).toBe(false);

    runner.runForTenant.mockResolvedValueOnce(complete);
    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ ran: 1 });
    expect(redis.store.has(DONE)).toBe(true);
  });

  it('re-checks the done marker after taking the lock', async () => {
    const { redis, runner, scheduler } = setup(() => Promise.resolve(complete));
    // Another worker completes the run between our first check and our lock.
    redis.onExists = (key, call) => {
      if (call === 2) redis.store.set(key, 'by another worker');
    };
    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ skipped: 1, ran: 0 });
    expect(runner.runForTenant).not.toHaveBeenCalled();
    expect(redis.store.has(LOCK)).toBe(false);
  });

  it('renews the lock lease while a long run is in progress', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let finish: (o: EndOfDayOutcome) => void = () => undefined;
    const { redis, scheduler } = setup(
      () =>
        new Promise<EndOfDayOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const tick = scheduler.tick(NOW);
    await vi.waitFor(() => {
      expect(redis.store.has(LOCK)).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS * 2);
    expect(redis.pexpires.length).toBeGreaterThanOrEqual(5);
    expect(new Set(redis.pexpires)).toEqual(new Set([LOCK_TTL_MS]));

    finish(complete);
    await expect(tick).resolves.toMatchObject({ ran: 1 });
    const renewals = redis.pexpires.length;
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS * 2);
    expect(redis.pexpires.length).toBe(renewals);
  });

  it('does not run while another worker holds the lock', async () => {
    const { redis, runner, scheduler } = setup(() => Promise.resolve(complete));
    redis.store.set(LOCK, 'someone else');
    await expect(scheduler.tick(NOW)).resolves.toMatchObject({ skipped: 1 });
    expect(runner.runForTenant).not.toHaveBeenCalled();
    expect(redis.store.get(LOCK)).toBe('someone else');
  });
});
