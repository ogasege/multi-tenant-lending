import type { S3ClientConfig } from '@aws-sdk/client-s3';

import type { Env } from '../../config/env.schema';

/** The subset of the runtime contract (SPEC §12) the AWS clients depend on. */
export type AwsEnv = Pick<Env, 'AWS_REGION' | 'AWS_ENDPOINT_URL'>;

/** Settings shared by every SDK v3 client (S3 today, SQS next). */
export interface AwsClientConfig {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * LocalStack accepts any credentials; these are never valid against real AWS, so they can
 * only ever be used together with an explicit endpoint override.
 */
const LOCALSTACK_CREDENTIALS = Object.freeze({ accessKeyId: 'test', secretAccessKey: 'test' });

/**
 * Base configuration for an AWS SDK v3 client.
 *
 * - In AWS (no `AWS_ENDPOINT_URL`): only the region is set, so the SDK uses its default
 *   credential provider chain, i.e. the ECS task role. No static keys exist in the app.
 * - Locally / in tests (`AWS_ENDPOINT_URL` set, LocalStack): requests go to that endpoint
 *   with static dummy credentials.
 *
 * Add new clients (e.g. `SQSClient`) by spreading this object into their config.
 */
export function awsClientConfig(env: AwsEnv): AwsClientConfig {
  if (!env.AWS_ENDPOINT_URL) return { region: env.AWS_REGION };
  return {
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL,
    credentials: { ...LOCALSTACK_CREDENTIALS },
  };
}

/**
 * S3 client configuration. Against LocalStack, path-style addressing
 * (`http://host:port/bucket/key`) is required because virtual-hosted bucket sub-domains of
 * `localhost` do not resolve.
 */
export function s3ClientConfig(env: AwsEnv): S3ClientConfig {
  const base = awsClientConfig(env);
  return base.endpoint ? { ...base, forcePathStyle: true } : base;
}
