import { z } from 'zod';

import { isOriginSuffix, parseCellOriginMap, parseOrigin } from './cell-origins';

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
  // Only the worker process receives these (least privilege); validated in WorkerModule.
  DATABASE_WORKER_PASSWORD: z.string().min(1).optional(),
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
  /**
   * Endpoint that BROWSER-facing presigned S3 URLs are signed for (logo GET, upload POST),
   * when it differs from the one the server reaches: locally the containers use
   * `http://localstack:4566` but a browser needs `http://localhost:4566`. Unset in AWS (the
   * regional S3 endpoint is public). Server-side S3 calls always use `AWS_ENDPOINT_URL`.
   */
  S3_PUBLIC_ENDPOINT_URL: z.url().optional(),

  // Cell-based deployment (SPEC §4.1). CELL_REGION defaults to AWS_REGION (see parseEnv).
  CELL_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'CELL_REGION must be an AWS region code')
    .optional(),
  /** Stable public origin of this cell, e.g. https://af-south-1.api.example.com. */
  CELL_API_BASE_URL: z.url(),
  /** DynamoDB global table holding the tenant directory projection. */
  DIRECTORY_TABLE_NAME: z.string().min(3).max(255),
  /**
   * Trusted cells: JSON map region → public origin. Redirects (307), 421 hints and the
   * unverified-token cell hint are only ever produced for these regions/origins. Either this
   * or `CELL_ORIGIN_SUFFIX` is required in production.
   */
  CELL_ORIGINS: z.string().optional(),
  /** Alternative to `CELL_ORIGINS`: a cell's origin is `https://<region><suffix>`. */
  CELL_ORIGIN_SUFFIX: z
    .string()
    .refine(isOriginSuffix, 'CELL_ORIGIN_SUFFIX must look like .api.example.com')
    .optional(),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  // Per authenticated principal / per tenant and principal class / per anonymous client IP,
  // per minute. Staff and customers of one tenant have SEPARATE tenant budgets, so
  // self-registered customers can never exhaust the budget the lender's staff depend on.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_TENANT_STAFF_PER_MINUTE: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE: z.coerce.number().int().positive().default(1500),
  RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().positive().default(60),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** New customer registrations per institution per hour (on top of the per-IP `auth` limit). */
  SIGNUP_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),

  /**
   * Identity (BVN/NIN) verification provider. Only `mock` exists today and it is refused in
   * production; a real provider (NIBSS BVN, NIMC NIN, Smile ID…) plugs in behind the
   * `IdentityVerifier` port in src/modules/customers/kyc.ts.
   */
  KYC_PROVIDER: z.enum(['mock']).default('mock'),
  /**
   * Disbursement payment provider and credit bureau. Only `mock` exists today and both are
   * refused in production (API role), like `KYC_PROVIDER`; real adapters plug in behind the
   * `PaymentGateway` and `CreditBureauPort` ports (see lending.module.ts).
   */
  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
  CREDIT_BUREAU_PROVIDER: z.enum(['mock']).default('mock'),
  /**
   * Procurement platform that resolves a checkout order to its vendor payee (VENDOR
   * products). Only `mock` exists today; refused in production (API role).
   */
  CHECKOUT_ORDERS_PROVIDER: z.enum(['mock']).default('mock'),

  /** How many days before business today a repayment's value date may be (0 = today only). */
  REPAYMENT_MAX_BACKDATE_DAYS: z.coerce.number().int().min(0).max(31).default(3),

  /**
   * Test-only escape hatch for the webhook SSRF guard: allows endpoints that resolve to
   * loopback/private addresses (an e2e HTTPS server on localhost). Refused in production.
   */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool,
});

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * Validated configuration; `CELL_REGION` is always resolved (it defaults to `AWS_REGION`) and
 * `CELL_ORIGINS` is the parsed region → origin map.
 */
export type Env = Omit<ParsedEnv, 'CELL_REGION' | 'CELL_ORIGINS'> & {
  CELL_REGION: string;
  CELL_ORIGINS?: Readonly<Record<string, string>>;
};

/** Secrets checked for the `local-only` placeholder prefix used by docker-compose. */
const SECRET_KEYS = [
  'JWT_SECRET',
  'BVN_HMAC_KEY',
  'DATA_ENCRYPTION_KEY',
  'DATABASE_APP_PASSWORD',
  'DATABASE_WORKER_PASSWORD',
] as const;

/**
 * The example key published in `.env.example`. It is public, so production must refuse it even
 * though it has no `local-only` prefix (AES keys must be valid base64 of 32 bytes).
 */
export const EXAMPLE_DATA_ENCRYPTION_KEY = 'KxYDvv0jXoo/um4MPAcodSDapq4+tffmMbI0JnYv+YI=';

const fail = (key: string, message: string): never => {
  throw new Error(`Invalid environment configuration:\n  - ${key}: ${message}`);
};

/**
 * Which process is booting. The shared contract (TLS, secrets, cells) is checked for both;
 * checks that guard API-only features (KYC) apply to the API alone, so the worker, which
 * never verifies identities, does not have to carry API-only settings.
 */
export type ProcessRole = 'api' | 'worker';

export interface ParseEnvOptions {
  role?: ProcessRole;
}

/** Production-only hardening (L7, L10): refuse settings that are only safe locally. */
function assertProductionSafe(env: ParsedEnv, cellRegion: string, role: ProcessRole): void {
  const issues: string[] = [];
  const check = (ok: boolean, key: string, message: string) => {
    if (!ok) issues.push(`  - ${key}: ${message}`);
  };
  check(env.DATABASE_SSL, 'DATABASE_SSL', 'must be true in production');
  check(
    new URL(env.REDIS_URL).protocol === 'rediss:',
    'REDIS_URL',
    'must use TLS (rediss://) in production',
  );
  check(!env.AWS_ENDPOINT_URL, 'AWS_ENDPOINT_URL', 'must not be set in production');
  check(
    !env.S3_PUBLIC_ENDPOINT_URL || new URL(env.S3_PUBLIC_ENDPOINT_URL).protocol === 'https:',
    'S3_PUBLIC_ENDPOINT_URL',
    'must use https:// in production',
  );
  for (const key of SECRET_KEYS) {
    check(!env[key]?.startsWith('local-only'), key, 'is a local placeholder secret');
  }
  check(
    env.DATA_ENCRYPTION_KEY !== EXAMPLE_DATA_ENCRYPTION_KEY,
    'DATA_ENCRYPTION_KEY',
    'is the public example key from .env.example',
  );
  check(
    !env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
    'WEBHOOK_ALLOW_PRIVATE_TARGETS',
    'must not be enabled in production',
  );
  check(
    // Widened on purpose: real providers will join the enum. API-only: the worker does no KYC.
    role !== 'api' || (env.KYC_PROVIDER as string) !== 'mock',
    'KYC_PROVIDER',
    'the mock identity verifier must not be used in production',
  );
  for (const key of [
    'PAYMENT_PROVIDER',
    'CREDIT_BUREAU_PROVIDER',
    'CHECKOUT_ORDERS_PROVIDER',
  ] as const) {
    check(
      role !== 'api' || (env[key] as string) !== 'mock',
      key,
      'the mock adapter must not be used in production',
    );
  }
  check(
    Boolean(env.CELL_ORIGINS ?? env.CELL_ORIGIN_SUFFIX),
    'CELL_ORIGINS',
    `CELL_ORIGINS or CELL_ORIGIN_SUFFIX is required (cell ${cellRegion})`,
  );
  if (issues.length > 0) {
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
}

export function parseEnv(
  source: NodeJS.ProcessEnv = process.env,
  { role = 'api' }: ParseEnvOptions = {},
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = result.data;
  const production = env.NODE_ENV === 'production';
  const cellRegion = env.CELL_REGION ?? env.AWS_REGION;
  // Cells redirect clients to each other's origin: it must be a bare https:// origin. Plain
  // http:// is accepted only outside production (no loopback exception in production).
  const ownOrigin = parseOrigin(env.CELL_API_BASE_URL, !production);
  if (!ownOrigin) fail('CELL_API_BASE_URL', 'must be a bare https:// origin');
  if (production) assertProductionSafe(env, cellRegion, role);

  let cellOrigins: Readonly<Record<string, string>> | undefined;
  if (env.CELL_ORIGINS) {
    try {
      cellOrigins = parseCellOriginMap(env.CELL_ORIGINS, !production);
    } catch (err) {
      fail('CELL_ORIGINS', (err as Error).message);
    }
    const listed = cellOrigins?.[cellRegion];
    if (listed !== undefined && listed !== ownOrigin) {
      fail('CELL_ORIGINS', `the entry for ${cellRegion} must equal CELL_API_BASE_URL`);
    }
  }
  return { ...env, CELL_REGION: cellRegion, CELL_ORIGINS: cellOrigins };
}
