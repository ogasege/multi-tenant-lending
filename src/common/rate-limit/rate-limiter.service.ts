import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import {
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from 'rate-limiter-flexible';

import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { REDIS } from '../redis/redis.module';

/**
 * Budgets:
 * - `principal`: per authenticated principal, per minute;
 * - `tenant-staff` / `tenant-customer`: per tenant AND principal class, per minute — a lender's
 *   customers (who can self-register) can never exhaust the budget its staff depend on;
 * - `anonymous`: per client IP for unauthenticated requests (incl. bad tokens), per minute;
 * - `auth`: stricter per-IP budget for credential endpoints, per minute;
 * - `signup`: new customer registrations per institution, per hour.
 */
export type RateLimitBudget =
  'principal' | 'tenant-staff' | 'tenant-customer' | 'anonymous' | 'auth' | 'signup';

export type RateLimitCheck = readonly [budget: RateLimitBudget, key: string];

interface Policy {
  name: RateLimitBudget;
  points: number;
  windowSeconds: number;
  limiter: RateLimiterAbstract;
}

interface ResponseState {
  policies: string[];
  states: string[];
}

/** Raised when a budget is exhausted; rendered as 429 problem+json with `Retry-After`. */
export class RateLimitedError extends AppError {
  constructor(
    readonly budget: RateLimitBudget,
    readonly points: number,
    readonly windowSeconds: number,
    readonly retryAfterSeconds: number,
  ) {
    super(429, ErrorCode.RATE_LIMITED, 'Too many requests; retry later', { retryAfterSeconds });
  }
}

/**
 * Redis-backed counters (rate-limiter-flexible, atomic per key), shared by the guards and the
 * cell-routing middleware so every layer draws on the SAME budgets.
 *
 * - Counters live in Redis, so limits hold across every API task behind the load balancer.
 * - If Redis is unavailable, each task falls back to an in-memory "insurance" limiter: limits
 *   degrade to per-task instead of failing every request or silently allowing everything.
 * - A request is charged at most once per (budget, key), however many layers check it.
 * - Responses carry the IETF RateLimit-Policy / RateLimit headers
 *   (draft-ietf-httpapi-ratelimit-headers) for every budget consumed.
 */
@Injectable()
export class RateLimiterService {
  private readonly policies: Readonly<Record<RateLimitBudget, Policy>>;
  private readonly charged = new WeakMap<Request, Set<string>>();
  private readonly headerState = new WeakMap<Response, ResponseState>();

  constructor(@Inject(REDIS) redis: Redis, @Inject(APP_CONFIG) config: Env) {
    const make = (name: RateLimitBudget, points: number, windowSeconds = 60): Policy => ({
      name,
      points,
      windowSeconds,
      limiter: new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `rl:${name}`,
        points,
        duration: windowSeconds,
        insuranceLimiter: new RateLimiterMemory({ points, duration: windowSeconds }),
      }),
    });
    this.policies = {
      principal: make('principal', config.RATE_LIMIT_PER_MINUTE),
      'tenant-staff': make('tenant-staff', config.RATE_LIMIT_TENANT_STAFF_PER_MINUTE),
      'tenant-customer': make('tenant-customer', config.RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE),
      anonymous: make('anonymous', config.RATE_LIMIT_PUBLIC_PER_MINUTE),
      auth: make('auth', config.AUTH_RATE_LIMIT_PER_MINUTE),
      signup: make('signup', config.SIGNUP_RATE_LIMIT_PER_HOUR, 3600),
    };
  }

  /**
   * Consumes one point from `budget` for `key`; throws {@link RateLimitedError} when the
   * budget is exhausted. For use outside HTTP plumbing (e.g. a use case).
   */
  async consume(budget: RateLimitBudget, key: string): Promise<RateLimiterRes> {
    const policy = this.policies[budget];
    try {
      return await policy.limiter.consume(key);
    } catch (err) {
      if (!(err instanceof RateLimiterRes)) throw err;
      const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
      throw new RateLimitedError(budget, policy.points, policy.windowSeconds, retryAfter);
    }
  }

  /**
   * Charges every check for this request (once per budget/key, even across layers) and
   * writes the RateLimit headers; on exhaustion sets `Retry-After` and rethrows the 429.
   */
  async enforce(req: Request, res: Response, checks: readonly RateLimitCheck[]): Promise<void> {
    let charged = this.charged.get(req);
    if (!charged) {
      charged = new Set();
      this.charged.set(req, charged);
    }
    let state = this.headerState.get(res);
    if (!state) {
      state = { policies: [], states: [] };
      this.headerState.set(res, state);
    }
    for (const [budget, key] of checks) {
      const id = `${budget}\u0000${key}`;
      if (charged.has(id)) continue;
      charged.add(id);
      const policy = this.policies[budget];
      try {
        const r = await this.consume(budget, key);
        state.policies.push(`"${budget}";q=${policy.points};w=${policy.windowSeconds}`);
        state.states.push(
          `"${budget}";r=${r.remainingPoints};t=${Math.ceil(r.msBeforeNext / 1000)}`,
        );
      } catch (err) {
        if (err instanceof RateLimitedError) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
          res.setHeader(
            'RateLimit-Policy',
            `"${budget}";q=${policy.points};w=${policy.windowSeconds}`,
          );
          res.setHeader('RateLimit', `"${budget}";r=0;t=${err.retryAfterSeconds}`);
        }
        throw err;
      }
    }
    if (state.policies.length > 0) {
      res.setHeader('RateLimit-Policy', state.policies.join(', '));
      res.setHeader('RateLimit', state.states.join(', '));
    }
  }
}
