import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { IS_PUBLIC } from '../auth/decorators';
import { TokenService } from '../auth/token.service';

import { clientKey } from './client-key';
import { SKIP_RATE_LIMIT } from './rate-limit.decorators';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Registered BEFORE `AuthGuard`. A protected route called without a valid access token (none,
 * malformed, expired, forged, or from another cell) is charged to the caller's anonymous
 * per-IP budget before any authentication work — including the 421 cell lookup — is done,
 * so floods of bad tokens are throttled instead of failing for free. Requests with a valid
 * token pass untouched (their principal/tenant budgets are charged after authentication);
 * public routes are charged by `RateLimitGuard`.
 */
@Injectable()
export class PreAuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_RATE_LIMIT, targets)) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (this.hasValidToken(req)) return true;
    await this.limiter.enforce(req, http.getResponse<Response>(), [
      ['anonymous', clientKey(req.ip)],
    ]);
    return true;
  }

  /** Signature/claims check only (no I/O); `AuthGuard` repeats it and does the rest. */
  private hasValidToken(req: Request): boolean {
    const [scheme, token] = req.header('authorization')?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) return false;
    try {
      this.tokens.verifyAccessToken(token);
      return true;
    } catch {
      return false;
    }
  }
}
