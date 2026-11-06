import { Global, Module } from '@nestjs/common';

import { parseWorkerEnv, type WorkerEnv } from './worker-env.schema';

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/**
 * Worker-process configuration (`WORKER_CONFIG`): the shared contract plus worker settings
 * and the REQUIRED `lending_worker` credentials. Parsing fails fast at boot when any is
 * missing. Never imported by the HTTP API.
 */
@Global()
@Module({
  providers: [
    {
      provide: WORKER_CONFIG,
      useFactory: (): Readonly<WorkerEnv> => Object.freeze(parseWorkerEnv()),
    },
  ],
  exports: [WORKER_CONFIG],
})
export class WorkerConfigModule {}
