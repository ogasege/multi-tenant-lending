import { trustedCellOrigin } from './cell-origins';
import { parseEnv } from './env.schema';

const base = {
  NODE_ENV: 'development',
  DATABASE_HOST: 'db',
  DATABASE_NAME: 'lending',
  DATABASE_APP_PASSWORD: 'pw',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'j'.repeat(64),
  BVN_HMAC_KEY: 'b'.repeat(64),
  DATA_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
  SQS_DOMAIN_EVENTS_QUEUE_URL: 'https://sqs.af-south-1.amazonaws.com/1/q',
  S3_BRANDING_BUCKET: 'bucket',
  CELL_API_BASE_URL: 'https://af-south-1.api.example.com',
  DIRECTORY_TABLE_NAME: 'directory',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  DATABASE_SSL: 'true',
  REDIS_URL: 'rediss://redis:6379',
  CELL_ORIGINS: JSON.stringify({
    'af-south-1': 'https://af-south-1.api.example.com',
    'eu-west-3': 'https://eu-west-3.api.example.com',
  }),
};

describe('parseEnv', () => {
  it('defaults the split tenant budgets and the per-tenant sign-up cap', () => {
    expect(parseEnv(base)).toMatchObject({
      RATE_LIMIT_TENANT_STAFF_PER_MINUTE: 3000,
      RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE: 1500,
      SIGNUP_RATE_LIMIT_PER_HOUR: 30,
      KYC_PROVIDER: 'mock',
    });
  });

  it('boots a hardened production configuration (KYC aside)', () => {
    expect(() => parseEnv(production)).toThrow(/KYC_PROVIDER/);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['plain database connections', { DATABASE_SSL: 'false' }, /DATABASE_SSL/],
    ['Redis without TLS', { REDIS_URL: 'redis://redis:6379' }, /REDIS_URL/],
    ['a LocalStack endpoint', { AWS_ENDPOINT_URL: 'http://localstack:4566' }, /AWS_ENDPOINT_URL/],
    ['placeholder secrets', { JWT_SECRET: `local-only-${'x'.repeat(40)}` }, /JWT_SECRET/],
    ['placeholder DB passwords', { DATABASE_APP_PASSWORD: 'local-only-pw' }, /DATABASE_APP/],
    [
      'an http cell origin, even loopback',
      { CELL_API_BASE_URL: 'http://localhost:3000' },
      /CELL_API/,
    ],
    ['no trusted cell list', { CELL_ORIGINS: '' }, /CELL_ORIGINS/],
    [
      'a plain-http browser S3 endpoint',
      { S3_PUBLIC_ENDPOINT_URL: 'http://localhost:4566' },
      /S3_PUBLIC_ENDPOINT_URL/,
    ],
  ])('refuses %s in production', (_case, overrides, message) => {
    expect(() => parseEnv({ ...production, ...overrides })).toThrow(message);
  });

  it('accepts an https browser S3 endpoint in production and any URL locally', () => {
    const https = { ...production, S3_PUBLIC_ENDPOINT_URL: 'https://s3.af-south-1.amazonaws.com' };
    expect(parseEnv(https, { role: 'worker' }).S3_PUBLIC_ENDPOINT_URL).toBe(
      'https://s3.af-south-1.amazonaws.com',
    );
    expect(
      parseEnv({ ...base, S3_PUBLIC_ENDPOINT_URL: 'http://localhost:4566' }).S3_PUBLIC_ENDPOINT_URL,
    ).toBe('http://localhost:4566');
    expect(parseEnv(base).S3_PUBLIC_ENDPOINT_URL).toBeUndefined();
  });

  it('rejects a CELL_ORIGINS map that disagrees with this cell', () => {
    expect(() =>
      parseEnv({ ...base, CELL_ORIGINS: JSON.stringify({ 'af-south-1': 'https://other.test' }) }),
    ).toThrow(/CELL_ORIGINS/);
    expect(() => parseEnv({ ...base, CELL_ORIGINS: '["x"]' })).toThrow(/CELL_ORIGINS/);
  });

  it('defaults the adapters to mock and the repayment backdate window to 3 days', () => {
    expect(parseEnv(base)).toMatchObject({
      PAYMENT_PROVIDER: 'mock',
      CREDIT_BUREAU_PROVIDER: 'mock',
      CHECKOUT_ORDERS_PROVIDER: 'mock',
      REPAYMENT_MAX_BACKDATE_DAYS: 3,
    });
    expect(
      parseEnv({ ...base, REPAYMENT_MAX_BACKDATE_DAYS: '0' }).REPAYMENT_MAX_BACKDATE_DAYS,
    ).toBe(0);
    expect(() => parseEnv({ ...base, REPAYMENT_MAX_BACKDATE_DAYS: '-1' })).toThrow(
      /REPAYMENT_MAX_BACKDATE_DAYS/,
    );
    expect(() => parseEnv({ ...base, PAYMENT_PROVIDER: 'acme' })).toThrow(/PAYMENT_PROVIDER/);
  });

  it.each(['PAYMENT_PROVIDER', 'CREDIT_BUREAU_PROVIDER', 'CHECKOUT_ORDERS_PROVIDER'])(
    'refuses the mock %s in production for the API, not for the worker',
    (key) => {
      expect(() => parseEnv(production)).toThrow(new RegExp(`${key}: the mock adapter`));
      expect(() => parseEnv(production, { role: 'worker' })).not.toThrow();
    },
  );
});

describe('trustedCellOrigin', () => {
  it('trusts only configured cells', () => {
    const env = parseEnv({ ...production, NODE_ENV: 'development' });
    expect(trustedCellOrigin(env, 'eu-west-3')).toBe('https://eu-west-3.api.example.com');
    expect(trustedCellOrigin(env, 'af-south-1')).toBe('https://af-south-1.api.example.com');
    expect(trustedCellOrigin(env, 'ap-south-9')).toBeUndefined();
    expect(trustedCellOrigin(env, 'not a region')).toBeUndefined();
  });

  it('derives origins from CELL_ORIGIN_SUFFIX', () => {
    const env = parseEnv({ ...base, CELL_ORIGIN_SUFFIX: '.api.example.com' });
    expect(trustedCellOrigin(env, 'eu-west-3')).toBe('https://eu-west-3.api.example.com');
  });

  it('trusts only this cell when nothing is configured (development)', () => {
    const env = parseEnv(base);
    expect(trustedCellOrigin(env, 'eu-west-3')).toBeUndefined();
  });
});
