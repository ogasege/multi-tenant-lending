/** Exponential backoff with a cap: `min(base * 2^(attempt-1), cap)`. */
export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Delay before retry number `attempt` (1 = first retry after the first failure). No jitter:
 * SQS redelivery and the outbox poll interval already spread retries, and a deterministic
 * schedule is easier to reason about in an incident.
 */
export function retryDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  // 2^30 already exceeds any sane cap; clamp the exponent so the arithmetic stays finite.
  const exp = Math.min(attempt - 1, 30);
  return Math.min(policy.baseMs * 2 ** exp, policy.maxMs);
}

/**
 * Earliest time after the event occurred at which a row that has already failed `attempts`
 * times may be retried: the SUM of the individual (capped) delays. The outbox has no
 * "next attempt" column, so the relay derives eligibility from `occurred_at` and `attempts`;
 * its claim query encodes the same function in SQL and this one is its reference.
 */
export function cumulativeRetryDelayMs(attempts: number, policy: BackoffPolicy): number {
  let total = 0;
  for (let n = 1; n <= attempts; n++) total += retryDelayMs(n, policy);
  return total;
}

/**
 * Number of doublings before the cap is reached: k such that `base * 2^(k-1) < max` for all
 * attempts ≤ k (attempts beyond k each add exactly `max`).
 */
export function uncappedAttempts(policy: BackoffPolicy): number {
  let k = 0;
  while (k < 31 && policy.baseMs * 2 ** k < policy.maxMs) k++;
  return k;
}
