import { Global, Module } from '@nestjs/common';

import { type Env, parseEnv, type ProcessRole } from './env.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');

let currentRole: ProcessRole = 'api';

/**
 * Declares which process this is, BEFORE its Nest application is created: `worker.ts` calls
 * `declareProcessRole('worker')` so API-only production checks (KYC) are skipped there.
 * Not settable from the environment: an API process can never opt out of its own checks.
 */
export function declareProcessRole(role: ProcessRole): ProcessRole {
  const previous = currentRole;
  currentRole = role;
  return previous;
}

/** Validated, immutable configuration available everywhere via `@Inject(APP_CONFIG)`. */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): Readonly<Env> => Object.freeze(parseEnv(process.env, { role: currentRole })),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
