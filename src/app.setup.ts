import { type INestApplication, type VersioningOptions, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';

import type { Env } from './config/env.schema';
import { createValidationPipe } from './common/http/validation.pipe';

/** URI versioning (`/v1/...`); also applied by the OpenAPI export so paths match. */
export const API_VERSIONING: VersioningOptions = { type: VersioningType.URI, defaultVersion: '1' };

/** HTTP hardening and conventions shared by main.ts and the e2e test harness. */
export function configureApp(app: NestExpressApplication, config: Env): void {
  // Behind exactly one proxy hop (the ALB): req.ip comes from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '100kb' });
  app.use(helmet());
  app.enableCors({
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: [
      'X-Request-ID',
      'Idempotent-Replayed',
      'Retry-After',
      'RateLimit',
      'RateLimit-Policy',
    ],
  });
  app.enableVersioning(API_VERSIONING);
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('10mg Lending Core API')
    .setDescription(
      'Multi-tenant, white-label lending API. Tenant context comes from the access token; ' +
        'money amounts are integer strings in ISO-4217 minor units; errors are RFC 9457 ' +
        'problem details; money-moving POSTs require an Idempotency-Key header.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config);
}
