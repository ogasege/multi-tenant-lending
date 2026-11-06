import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { Public } from '../../common/auth/decorators';
import { SkipRateLimit } from '../../common/rate-limit/rate-limit.decorators';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { REDIS } from '../../common/redis/redis.module';

/**
 * Liveness: the process is up (ECS restarts the task if not).
 * Readiness: dependencies answer (the ALB stops routing to the task if not).
 * Kept separate so a database blip drains traffic instead of killing every task.
 * Uses @nestjs/terminus, the official NestJS health-check module (503 + details on failure).
 */
@ApiTags('Health')
@Public()
@SkipRateLimit()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly db: TransactionRunner,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (PostgreSQL + Redis)' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.probe('database', () => this.db.ping()),
      () => this.probe('redis', () => this.redis.ping()),
    ]);
  }

  private async probe(key: string, check: () => Promise<unknown>): Promise<HealthIndicatorResult> {
    const session = this.indicator.check(key);
    try {
      await check();
      return session.up();
    } catch {
      return session.down();
    }
  }
}
