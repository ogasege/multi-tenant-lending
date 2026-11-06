import { Test } from '@nestjs/testing';

import { APP_CONFIG, ConfigModule, declareProcessRole } from './config.module';
import { type Env, parseEnv } from './env.schema';
import { parseWorkerEnv } from './worker-env.schema';

const base = {
  NODE_ENV: 'test',
  DATABASE_HOST: 'localhost',
  DATABASE_NAME: 'lending',
  DATABASE_APP_PASSWORD: 'app',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(32),
  BVN_HMAC_KEY: 'b'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  SQS_DOMAIN_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/q',
  S3_BRANDING_BUCKET: 'bucket',
  CELL_API_BASE_URL: 'http://localhost:3000',
  DIRECTORY_TABLE_NAME: 'directory',
};

describe('worker configuration', () => {
  it('fails fast without the lending_worker password (the API does not need it)', () => {
    expect(() => parseWorkerEnv(base)).toThrow(/DATABASE_WORKER_PASSWORD/);
    expect(() => parseEnv(base)).not.toThrow();
  });

  it('applies defaults', () => {
    const env = parseWorkerEnv({ ...base, DATABASE_WORKER_PASSWORD: 'w' });
    expect(env).toMatchObject({
      DATABASE_WORKER_USER: 'lending_worker',
      OUTBOX_BATCH_SIZE: 50,
      WEBHOOK_TIMEOUT_MS: 10_000,
      SQS_WAIT_TIME_SECONDS: 20,
      EOD_RUN_AT_LOCAL_TIME: '00:05',
      WEBHOOK_ALLOW_PRIVATE_TARGETS: false,
    });
  });

  it('rejects an inverted backoff and a bad EOD time', () => {
    const env = { ...base, DATABASE_WORKER_PASSWORD: 'w' };
    expect(() =>
      parseWorkerEnv({ ...env, OUTBOX_RETRY_BASE_MS: '5000', OUTBOX_RETRY_MAX_MS: '100' }),
    ).toThrow(/OUTBOX_RETRY_MAX_MS/);
    expect(() => parseWorkerEnv({ ...env, EOD_RUN_AT_LOCAL_TIME: '25:00' })).toThrow(/EOD_RUN_AT/);
  });

  describe('in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_SSL: 'true',
      REDIS_URL: 'rediss://redis:6379',
      AWS_ENDPOINT_URL: undefined,
      SQS_DOMAIN_EVENTS_QUEUE_URL: 'https://sqs.af-south-1.amazonaws.com/1/q',
      CELL_API_BASE_URL: 'https://af-south-1.api.example.com',
      CELL_ORIGINS: JSON.stringify({ 'af-south-1': 'https://af-south-1.api.example.com' }),
      DATABASE_WORKER_PASSWORD: 'w',
      KYC_PROVIDER: 'mock',
    };

    it('skips the API-only KYC check for the worker but not for the API', () => {
      expect(() => parseEnv(production)).toThrow(/KYC_PROVIDER/);
      expect(() => parseWorkerEnv(production)).not.toThrow();
      expect(() => parseEnv(production, { role: 'worker' })).not.toThrow();
    });

    it.each([
      ['plain Redis', { REDIS_URL: 'redis://redis:6379' }, /REDIS_URL/],
      ['no database TLS', { DATABASE_SSL: 'false' }, /DATABASE_SSL/],
      [
        'placeholder secrets',
        { DATABASE_WORKER_PASSWORD: 'local-only-x' },
        /DATABASE_WORKER_PASSWORD/,
      ],
      ['a LocalStack endpoint', { AWS_ENDPOINT_URL: 'http://localstack:4566' }, /AWS_ENDPOINT_URL/],
      [
        'private webhook targets',
        { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' },
        /WEBHOOK_ALLOW_PRIVATE/,
      ],
    ])('still refuses %s for the worker', (_case, overrides, message) => {
      expect(() => parseWorkerEnv({ ...production, ...overrides })).toThrow(message);
    });

    it('ConfigModule applies the declared process role (worker.ts declares "worker")', async () => {
      const saved = { ...process.env };
      Object.assign(process.env, production);
      Reflect.deleteProperty(process.env, 'AWS_ENDPOINT_URL');
      const boot = async () =>
        (await Test.createTestingModule({ imports: [ConfigModule] }).compile()).get<Env>(
          APP_CONFIG,
        );
      try {
        await expect(boot()).rejects.toThrow(/KYC_PROVIDER/);
        const previous = declareProcessRole('worker');
        try {
          await expect(boot()).resolves.toMatchObject({ NODE_ENV: 'production' });
        } finally {
          declareProcessRole(previous);
        }
      } finally {
        process.env = saved;
      }
    });
  });
});
