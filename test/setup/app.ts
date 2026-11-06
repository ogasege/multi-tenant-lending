import type { INestApplication, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { App } from 'supertest/types';
import { inject } from 'vitest';

import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { APP_CONFIG } from '@/config/config.module';
import type { Env } from '@/config/env.schema';

export interface TestApp {
  app: INestApplication;
  http: App;
  close: () => Promise<void>;
}

/**
 * Boots the real AppModule (real guards, filters, pipes) against the shared test infrastructure.
 *
 * `envOverrides` change the configuration of THIS app only (e.g. a second cell with its own
 * `CELL_REGION` and `DATABASE_NAME`): configuration is parsed once while the module compiles,
 * so the overrides are applied to `process.env` just for that and then reverted. `configure`
 * can override providers (e.g. a strict fake procurement-platform adapter).
 */
export async function createTestApp(
  extraModules: Type[] = [],
  envOverrides: Record<string, string> = {},
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const base = inject('env');
  Object.assign(process.env, base, envOverrides);
  try {
    const moduleRef = await configure(
      Test.createTestingModule({ imports: [AppModule, ...extraModules] }),
    ).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, app.get<Env>(APP_CONFIG));
    await app.init();
    return { app, http: app.getHttpServer() as App, close: () => app.close() };
  } finally {
    for (const key of Object.keys(envOverrides)) {
      const original = base[key];
      if (original === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = original;
    }
  }
}
