import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { inject } from 'vitest';

import { declareProcessRole } from '@/config/config.module';
import { WorkerModule } from '@/worker.module';

export interface TestWorker {
  app: INestApplicationContext;
  close: () => Promise<void>;
}

/**
 * Boots the real WorkerModule (outbox relay, webhook dispatcher, directory jobs) against the
 * shared test infrastructure, as `node dist/worker.js` would, minus the signal handlers.
 * `envOverrides` apply to this worker only (configuration is parsed while compiling);
 * `configure` can override providers (e.g. trust the test TLS CA).
 */
export async function createTestWorker(
  envOverrides: Record<string, string> = {},
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestWorker> {
  const base = inject('env');
  Object.assign(process.env, base, envOverrides);
  // As worker.ts does; restored afterwards so API apps built later get the API checks.
  const previousRole = declareProcessRole('worker');
  try {
    const moduleRef = await configure(
      Test.createTestingModule({ imports: [WorkerModule] }),
    ).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    return { app: moduleRef, close: () => moduleRef.close() };
  } finally {
    declareProcessRole(previousRole);
    for (const key of Object.keys(envOverrides)) {
      const original = base[key];
      if (original === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = original;
    }
  }
}
