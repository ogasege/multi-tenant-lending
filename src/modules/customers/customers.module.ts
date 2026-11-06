import { Module } from '@nestjs/common';

import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import { TenantResolver } from '../../common/database/tenant-resolver';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import { GetCustomer, GetMyCustomer, ListCustomers } from './customer-queries.use-case';
import { CustomersController } from './customers.controller';
import { IDENTITY_VERIFIER, type IdentityVerifier, MockIdentityVerifier } from './kyc';
import { RegisterCustomer } from './register-customer.use-case';

/** One factory per `KYC_PROVIDER` value (exhaustive: a new provider must be bound here). */
const VERIFIERS: Readonly<Record<Env['KYC_PROVIDER'], () => IdentityVerifier>> = {
  mock: () => new MockIdentityVerifier(),
};

/** Borrowers: self-registration with KYC (provider per `KYC_PROVIDER`), and profile queries. */
@Module({
  controllers: [CustomersController],
  providers: [
    PasswordService,
    TenantSessions,
    TenantResolver,
    {
      provide: IDENTITY_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: Env): IdentityVerifier => VERIFIERS[config.KYC_PROVIDER](),
    },
    RegisterCustomer,
    GetMyCustomer,
    GetCustomer,
    ListCustomers,
  ],
})
export class CustomersModule {}
