import { Module } from '@nestjs/common';

import { AwsModule } from './common/aws/aws.module';
import { CommonModule } from './common/common.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { HealthModule } from './modules/health/health.module';

/**
 * HTTP API composition root. Feature modules are independent bounded contexts: none imports
 * another's internals; cross-cutting concerns come from CommonModule.
 */
@Module({
  imports: [
    CommonModule,
    AwsModule,
    HealthModule,
    // Global control plane: tenant directory + cell routing (307 / 421)
    DirectoryModule,
  ],
})
export class AppModule {}
