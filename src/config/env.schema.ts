import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters (use a random 256-bit value)`);

/**
 * Environment contract (docs/design/SPEC.md §12). Validated once at boot so the process
 * fails fast on misconfiguration instead of failing later at the first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().min(1),
  DATABASE_SSL: bool,
  DATABASE_APP_USER: z.string().default('lending_app'),
  DATABASE_APP_PASSWORD: z.string().min(1),
  DATABASE_WORKER_USER: z.string().default('lending_worker'),
  DATABASE_WORKER_PASSWORD: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.url(),

  JWT_SECRET: secret('JWT_SECRET'),
  JWT_ISSUER: z.string().default('tenmg-lending'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  BVN_HMAC_KEY: secret('BVN_HMAC_KEY'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key'),

  AWS_REGION: z.string().default('af-south-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_DOMAIN_EVENTS_QUEUE_URL: z.url(),
  S3_BRANDING_BUCKET: z.string().min(3),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
