import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import { type AwsEnv, awsClientConfig } from './aws.config';

/** Injection token for the shared, long-lived `SQSClient` (worker process). */
export const SQS_CLIENT = Symbol('SQS_CLIENT');

/**
 * SQS client configuration: the shared AWS settings (task role in AWS, LocalStack locally)
 * plus bounded SDK retries. Long-poll receives are cancelled through an `AbortSignal` on
 * shutdown, so no request timeout is set here (a 20 s long poll must not time out).
 */
export function sqsClientConfig(env: AwsEnv): SQSClientConfig {
  return { ...awsClientConfig(env), maxAttempts: 3 };
}

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /** Releases the client's keep-alive sockets so the process can exit cleanly. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

/** Provides `SQS_CLIENT`; imported by the worker (outbox relay + webhook dispatcher). */
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: Env): SQSClient => new SQSClient(sqsClientConfig(config)),
    },
    SqsClientLifecycle,
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
