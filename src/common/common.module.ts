import { randomUUID } from 'node:crypto';

import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { ClsModule, ClsServiceManager } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { APP_CONFIG, ConfigModule } from '../config/config.module';
import type { Env } from '../config/env.schema';

import { AuditWriter } from './audit/audit-writer';
import { AccessRevocations } from './auth/access-revocations';
import { AuthGuard } from './auth/auth.guard';
import { TokenService } from './auth/token.service';
import type { RequestContextStore } from './context/request-context';
import { DatabaseModule } from './database/database.module';
import { ProblemDetailsFilter } from './errors/problem-details.filter';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { OutboxWriter } from './outbox/outbox-writer';
import { PreAuthRateLimitGuard } from './rate-limit/pre-auth-rate-limit.guard';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimiterService } from './rate-limit/rate-limiter.service';
import { RedisModule } from './redis/redis.module';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Cross-cutting infrastructure shared by every feature module of the HTTP API. */
@Global()
@Module({
  imports: [
    ConfigModule,
    // Request context (AsyncLocalStorage): request id, principal, tenant — set once, read anywhere.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        // Accept a well-formed upstream X-Request-ID (ALB/gateway) for end-to-end tracing.
        idGenerator: (req: Request) => {
          const incoming = req.header('x-request-id');
          return incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        },
        setup: (cls, req: Request, res: Response) => {
          cls.set('requestId', cls.getId());
          // Echo the id so clients and support can correlate a response with our logs.
          res.setHeader('X-Request-ID', cls.getId());
          cls.set('ip', req.ip);
          cls.set('userAgent', req.header('user-agent')?.slice(0, 256));
        },
      },
    }),
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (c: Env) => ({
        pinoHttp: {
          level: c.LOG_LEVEL,
          genReqId: () => ClsServiceManager.getClsService().getId(),
          customProps: () => {
            const cls = ClsServiceManager.getClsService<RequestContextStore>();
            return cls.isActive()
              ? { tenantId: cls.get('tenantId'), principalId: cls.get('principal')?.id }
              : {};
          },
          // Never log credentials, tokens or national identifiers.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["idempotency-key"]',
              '*.password',
              '*.refreshToken',
              '*.nationalId',
              '*.bvn',
            ],
            censor: '[REDACTED]',
          },
          transport:
            c.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (c: Env) => ({ secret: c.JWT_SECRET }),
    }),
    DatabaseModule,
    RedisModule,
  ],
  providers: [
    TokenService,
    AuditWriter,
    OutboxWriter,
    AccessRevocations,
    RateLimiterService,
    // Order matters: (1) charge requests without a valid token to the anonymous per-IP budget
    // BEFORE any authentication work; (2) authenticate; (3) rate-limit on principal and tenant.
    { provide: APP_GUARD, useClass: PreAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
  exports: [TokenService, AuditWriter, OutboxWriter, AccessRevocations, RateLimiterService],
})
export class CommonModule {}
