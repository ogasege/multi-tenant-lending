import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { declareProcessRole } from './config/config.module';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint (`node dist/worker.js`): a Nest application context without an HTTP
 * server. SIGTERM (ECS stop, `docker compose stop`) triggers the shutdown hooks: loops stop
 * polling and drain their in-flight batch, then the pools and clients are closed. The ECS
 * stopTimeout / compose stop_grace_period (60 s) bounds the drain.
 */
async function bootstrap(): Promise<void> {
  // The worker does no KYC: API-only production checks do not apply to it.
  declareProcessRole('worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.init();
  logger.log('worker started');
}

bootstrap().catch((err: unknown) => {
  // Configuration and connection errors at boot: fail fast with a non-zero exit code.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'worker failed to start', err: String(err) })}\n`,
  );
  process.exit(1);
});
