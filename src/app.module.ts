import { Module } from '@nestjs/common';

import { AwsModule } from './common/aws/aws.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './modules/health/health.module';

/**
 * HTTP API composition root. Feature modules are independent bounded contexts: none imports
 * another's internals; cross-cutting concerns come from CommonModule.
 */
@Module({
  imports: [CommonModule, AwsModule, HealthModule],
})
export class AppModule {}
