import { Module } from '@nestjs/common';

import { AwsModule } from './common/aws/aws.module';
import { CommonModule } from './common/common.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { HealthModule } from './modules/health/health.module';
import { InstitutionsModule } from './modules/institutions/institutions.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { LendingModule } from './modules/lending/lending.module';
import { LoanProductsModule } from './modules/loan-products/loan-products.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PlatformModule } from './modules/platform/platform.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

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
    // Multi-tenancy, identity, RBAC
    PlatformModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    // White-label configuration
    InstitutionsModule,
    LoanProductsModule,
    // Lending workflow, double-entry ledger, end-of-day processing, audit trail
    LedgerModule,
    LendingModule,
    OperationsModule,
    AuditModule,
    // Lender-facing webhook endpoint management (delivery runs in the worker process)
    WebhooksModule,
  ],
})
export class AppModule {}
