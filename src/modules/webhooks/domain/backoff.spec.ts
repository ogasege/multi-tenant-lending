import fc from 'fast-check';

import { cumulativeRetryDelayMs, retryDelayMs, uncappedAttempts } from './backoff';

/** The closed form the outbox relay evaluates in SQL (see OutboxRelay.claim). */
function sqlSchedule(attempts: number, baseMs: number, maxMs: number): number {
  const k = uncappedAttempts({ baseMs, maxMs });
  return attempts <= k
    ? baseMs * (2 ** attempts - 1)
    : baseMs * (2 ** k - 1) + (attempts - k) * maxMs;
}

describe('retry backoff', () => {
  const policy = { baseMs: 1_000, maxMs: 300_000 };

  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
    expect(retryDelayMs(9, policy)).toBe(256_000);
    expect(retryDelayMs(10, policy)).toBe(300_000);
    expect(retryDelayMs(1_000, policy)).toBe(300_000);
  });

  it('treats non-positive attempts as no delay', () => {
    expect(retryDelayMs(0, policy)).toBe(0);
    expect(retryDelayMs(-3, policy)).toBe(0);
    expect(retryDelayMs(1.5, policy)).toBe(0);
  });

  it('webhook redelivery: 30 s base, capped at 15 min', () => {
    const webhook = { baseMs: 30_000, maxMs: 900_000 };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, webhook) / 1000)).toEqual([
      30, 60, 120, 240, 480,
    ]);
  });

  it('the SQL eligibility schedule equals the sum of the capped delays', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (attempts, baseMs, extra) => {
          const maxMs = baseMs + extra;
          expect(sqlSchedule(attempts, baseMs, maxMs)).toBe(
            cumulativeRetryDelayMs(attempts, { baseMs, maxMs }),
          );
        },
      ),
    );
  });
});
