import { z } from 'zod';

import { type Env, parseEnv } from './env.schema';

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/**
 * Worker-only settings, validated on top of the shared contract (SPEC §12). The worker is the
 * only process that receives the `lending_worker` credentials, so they are REQUIRED here while
 * the API schema keeps them optional (and the API never reads them).
 */
export const workerEnvSchema = z.object({
  DATABASE_WORKER_USER: z.string().min(1).default('lending_worker'),
  DATABASE_WORKER_PASSWORD: z.string().min(1, 'DATABASE_WORKER_PASSWORD is required by the worker'),
  DATABASE_WORKER_POOL_MAX: int(1, 100, 5),

  /** Outbox relay: idle poll interval, rows per batch and retry backoff (exponential, capped). */
  OUTBOX_POLL_INTERVAL_MS: int(50, 60_000, 1_000),
  OUTBOX_BATCH_SIZE: int(1, 500, 50),
  OUTBOX_RETRY_BASE_MS: int(10, 3_600_000, 1_000),
  OUTBOX_RETRY_MAX_MS: int(10, 86_400_000, 300_000),

  /** Webhook dispatcher: SQS long-poll wait, per-request timeout and redelivery backoff. */
  SQS_WAIT_TIME_SECONDS: int(0, 20, 20),
  WEBHOOK_TIMEOUT_MS: int(100, 30_000, 10_000),
  WEBHOOK_RETRY_BASE_SECONDS: int(0, 43_200, 30),
  WEBHOOK_RETRY_MAX_SECONDS: int(0, 43_200, 900),

  /** Tenant directory reconciliation (also runs once at start-up). */
  DIRECTORY_RECONCILE_INTERVAL_MINUTES: int(1, 1_440, 10),

  /** End of day: run once per tenant per local date, after this local time (HH:mm). */
  EOD_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  EOD_RUN_AT_LOCAL_TIME: z
    .string()
    .regex(LOCAL_TIME, 'EOD_RUN_AT_LOCAL_TIME must be HH:mm')
    .default('00:05'),
  EOD_CHECK_INTERVAL_SECONDS: int(10, 3_600, 300),
});

export type WorkerSettings = z.infer<typeof workerEnvSchema>;
export type WorkerEnv = Env & WorkerSettings;

/** Shared contract + worker settings; throws (fail fast) when anything is missing or invalid. */
export function parseWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const base = parseEnv(source, { role: 'worker' });
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid worker configuration:\n${issues}`);
  }
  if (result.data.OUTBOX_RETRY_MAX_MS < result.data.OUTBOX_RETRY_BASE_MS) {
    throw new Error(
      'Invalid worker configuration:\n  - OUTBOX_RETRY_MAX_MS: must be >= OUTBOX_RETRY_BASE_MS',
    );
  }
  return { ...base, ...result.data };
}
