import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { buildOpenApi, configureApp } from './app.setup';
import { APP_CONFIG } from './config/config.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get<Env>(APP_CONFIG);
  configureApp(app, config);
  if (config.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApi(app));
  }
  const server = await app.listen(config.PORT, '0.0.0.0');
  // Bound slow clients (slowloris). Headers timeout must exceed the ALB idle timeout (60 s).
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;
}

void bootstrap();
