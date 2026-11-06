import { randomBytes } from 'node:crypto';

import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { LocalstackContainer } from '@testcontainers/localstack';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { createMigratedDatabase, startPostgres, TEST_DB } from './postgres';

declare module 'vitest' {
  export interface ProvidedContext {
    env: Record<string, string>;
  }
}

/** Pinned: the last LocalStack tag that runs without an auth token (see ADR on LocalStack). */
const LOCALSTACK_IMAGE = 'localstack/localstack:4.14.0';
const BUCKET = 'lending-branding-test';
const QUEUE = 'lending-domain-events-test';
const DIRECTORY_TABLE = 'lending-tenant-directory-test';
/** Database of the simulated second cell (eu-west-3) in multi-cell journeys. */
const CELL_B_DB = 'lending_cell_b';

/**
 * Starts real infrastructure ONCE per test run (Postgres 16 with migrations applied as a
 * non-superuser owner, Redis 7, LocalStack S3 + SQS + DynamoDB) and hands connection
 * settings to every test file via Vitest's provide/inject.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, redis, localstack] = await Promise.all([
    startPostgres(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new LocalstackContainer(LOCALSTACK_IMAGE)
      .withEnvironment({
        SERVICES: 's3,sqs,dynamodb',
        ...(process.env.LOCALSTACK_AUTH_TOKEN
          ? { LOCALSTACK_AUTH_TOKEN: process.env.LOCALSTACK_AUTH_TOKEN }
          : {}),
      })
      .start(),
  ]);

  await createMigratedDatabase(pg, CELL_B_DB);

  const endpoint = localstack.getConnectionUri();
  const aws = {
    region: 'af-south-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  await new S3Client({ ...aws, forcePathStyle: true }).send(
    new CreateBucketCommand({ Bucket: BUCKET }),
  );
  const queue = await new SQSClient(aws).send(new CreateQueueCommand({ QueueName: QUEUE }));
  // Same key schema as the Terraform global table (SPEC §4.1): pk `slug`, on-demand.
  await new DynamoDBClient(aws).send(
    new CreateTableCommand({
      TableName: DIRECTORY_TABLE,
      AttributeDefinitions: [{ AttributeName: 'slug', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );

  project.provide('env', {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_HOST: pg.host,
    DATABASE_PORT: String(pg.port),
    DATABASE_NAME: TEST_DB.name,
    DATABASE_SSL: 'false',
    DATABASE_APP_USER: 'lending_app',
    DATABASE_APP_PASSWORD: TEST_DB.appPassword,
    DATABASE_WORKER_USER: 'lending_worker',
    DATABASE_WORKER_PASSWORD: TEST_DB.workerPassword,
    REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_ISSUER: 'tenmg-lending-test',
    BVN_HMAC_KEY: randomBytes(32).toString('hex'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AWS_REGION: 'af-south-1',
    AWS_ENDPOINT_URL: endpoint,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_DOMAIN_EVENTS_QUEUE_URL: queue.QueueUrl ?? '',
    S3_BRANDING_BUCKET: BUCKET,
    CELL_REGION: 'af-south-1',
    CELL_API_BASE_URL: 'http://cell-af-south-1.test',
    DIRECTORY_TABLE_NAME: DIRECTORY_TABLE,
    // Not part of the app contract: read by test/e2e/cell-routing.e2e.spec.ts for cell B.
    TEST_CELL_B_DATABASE_NAME: CELL_B_DB,
    // Trusted cells of the multi-cell journeys (cell-routing.e2e.spec.ts overrides per cell).
    CELL_ORIGINS: JSON.stringify({
      'af-south-1': 'http://cell-af-south-1.test',
      'eu-west-3': 'http://cell-b.test',
    }),
    KYC_PROVIDER: 'mock',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_TENANT_STAFF_PER_MINUTE: '100000',
    RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE: '100000',
    RATE_LIMIT_PUBLIC_PER_MINUTE: '100000',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    SIGNUP_RATE_LIMIT_PER_HOUR: '100000',
  });

  return async () => {
    await Promise.all([pg.stop(), redis.stop(), localstack.stop()]);
  };
}
