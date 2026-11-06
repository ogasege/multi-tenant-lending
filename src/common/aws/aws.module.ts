import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import { s3ClientConfig } from './aws.config';

/** Injection token for the shared, long-lived `S3Client`. */
export const S3_CLIENT = Symbol('S3_CLIENT');

@Injectable()
class AwsClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly s3: S3Client) {}

  /** Releases the clients' HTTP keep-alive sockets so the process can exit cleanly. */
  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}

/**
 * AWS SDK v3 clients built from the validated runtime config (see `aws.config.ts`). One
 * client instance per service is shared process-wide, as the SDK recommends. Further clients
 * (SQS for the outbox relay) are added here as another token + factory provider.
 */
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: Env): S3Client => new S3Client(s3ClientConfig(config)),
    },
    AwsClientsLifecycle,
  ],
  exports: [S3_CLIENT],
})
export class AwsModule {}
