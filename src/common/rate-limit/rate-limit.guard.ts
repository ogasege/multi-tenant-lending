import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';

import { clientKey } from './client-key';
import {
  RATE_LIMIT_POLICY,
  type RateLimitPolicyName,
  SKIP_RATE_LIMIT,
} from './rate-limit.decorators';
import { type RateLimitCheck, RateLimiterService } from './rate-limiter.service';

/**
 * Application-layer rate limiting after authentication (the edge layer is AWS WAF's per-IP
 * rate-based rule; unauthenticated traffic is charged earlier by `PreAuthRateLimitGuard`).
 *
 * - Tenant users consume their per-principal budget AND their tenant's budget for their
 *   principal class (`tenant-staff` or `tenant-customer`): one lender cannot starve the others
 *   (noisy neighbour), and a lender's self-registered customers cannot lock out its staff.
 * - Platform administrators consume their per-principal budget.
 * - Anonymous requests are limited per client IP (IPv6 grouped by /64); credential endpoints
 *   use the stricter `auth` policy.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_RATE_LIMIT, targets)) {
      return true;
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const named = this.reflector.getAllAndOverride<RateLimitPolicyName | undefined>(
      RATE_LIMIT_POLICY,
      targets,
    );
    await this.limiter.enforce(req, http.getResponse<Response>(), this.checksFor(req, named));
    return true;
  }

  private checksFor(req: Request, named: RateLimitPolicyName | undefined): RateLimitCheck[] {
    if (named === 'auth') return [['auth', clientKey(req.ip)]];
    const principal = this.cls.get('principal');
    if (!principal) return [['anonymous', clientKey(req.ip)]];
    if (principal.kind !== 'USER') return [['principal', principal.id]];
    const tenantBudget = principal.role === 'CUSTOMER' ? 'tenant-customer' : 'tenant-staff';
    return [
      ['principal', principal.id],
      [tenantBudget, principal.tenantId],
    ];
  }
}
