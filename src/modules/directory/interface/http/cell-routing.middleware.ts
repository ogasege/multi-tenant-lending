import { STATUS_CODES } from 'node:http';

import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../../../../common/context/request-context';
import { TransactionRunner } from '../../../../common/database/transaction-runner';
import { ErrorCode } from '../../../../common/errors/error-codes';
import { PROBLEM_TYPE } from '../../../../common/errors/problem-details.filter';
import { clientKey } from '../../../../common/rate-limit/client-key';
import {
  RateLimitedError,
  RateLimiterService,
} from '../../../../common/rate-limit/rate-limiter.service';
import { APP_CONFIG } from '../../../../config/config.module';
import type { Env } from '../../../../config/env.schema';
import { DirectoryLookup } from '../../application/directory-lookup';
import { isValidSlug } from '../../domain/directory-entry';
import { decideRouting } from '../../domain/routing-decision';

/** `/v1/institutions/{slug}/…` — the slug is the path segment after `institutions`. */
const INSTITUTION_PATH = /^\/v\d+\/institutions\/([^/?#]+)(?:[/?#]|$)/;

/** The institution slug a request addresses: path segment, else login body. */
export function slugOfRequest(req: Pick<Request, 'originalUrl' | 'body'>): string | undefined {
  const fromPath = INSTITUTION_PATH.exec(req.originalUrl)?.[1];
  if (fromPath !== undefined) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(fromPath);
    } catch {
      return undefined;
    }
    return isValidSlug(decoded) ? decoded : undefined;
  }
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'institutionSlug' in body) {
    const slug = body.institutionSlug;
    return isValidSlug(slug) ? slug : undefined;
  }
  return undefined;
}

/**
 * Cell routing for slug-addressed public routes (SPEC §4.1). Runs before routing:
 *
 * 0. the caller's anonymous per-IP budget is charged FIRST (429 when exhausted), so routing
 *    lookups cannot be used to load the database or DynamoDB for free; the guards later
 *    reuse that charge instead of counting the request twice. A slug the directory cache
 *    already knows to be unknown short-circuits to (3) without touching the database;
 * 1. slug stored in this cell (`resolve_institution`) → served here;
 * 2. otherwise the tenant directory is consulted, and a tenant homed in another cell gets
 *    **307 Temporary Redirect** to `apiBaseUrl + originalUrl` (method and body preserved),
 *    with `X-Tenant-Cell: <region>` and a small problem+json body;
 * 3. anything else (unknown slug, directory unavailable, unsafe base URL) is served here
 *    exactly as without cells, so responses never reveal whether a slug exists elsewhere.
 *
 * Failures fail open to (3): routing is an optimisation of where a request is served, never
 * a reason to reject it. Only the rate limit rejects.
 */
@Injectable()
export class CellRoutingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CellRoutingMiddleware.name);
  private readonly allowInsecure: boolean;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly lookup: DirectoryLookup,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {
    this.allowInsecure = config.NODE_ENV === 'test' || config.NODE_ENV === 'development';
  }

  use(req: Request, res: Response, next: NextFunction): void {
    this.route(req, res).then(
      (handled) => {
        if (!handled) next();
      },
      (err: unknown) => {
        if (err instanceof RateLimitedError) {
          this.sendProblem(req, res, 429, ErrorCode.RATE_LIMITED, err.message, {
            retryAfterSeconds: err.retryAfterSeconds,
          });
          return;
        }
        this.logger.warn(`Cell routing skipped: ${String(err)}`);
        next();
      },
    );
  }

  /** Returns true when the response was sent (redirect). */
  private async route(req: Request, res: Response): Promise<boolean> {
    const slug = slugOfRequest(req);
    if (!slug) return false;
    await this.limiter.enforce(req, res, [['anonymous', clientKey(req.ip)]]);
    // Known-unknown slug (negative cache): served here either way, skip the DB lookup.
    if ((await this.lookup.peek(slug)) === null) return false;
    if (await this.runner.resolveInstitution(slug)) return false;

    const decision = decideRouting({
      slug,
      isLocal: false,
      entry: await this.lookup.find(slug),
      cellRegion: this.config.CELL_REGION,
      originalUrl: req.originalUrl,
      allowInsecure: this.allowInsecure,
      trustedOrigin: (region) => this.lookup.trustedOrigin(region),
    });
    if (decision.action === 'pass') return false;

    res.status(307).setHeader('Location', decision.location);
    res.setHeader('X-Tenant-Cell', decision.homeRegion);
    res.setHeader('Cache-Control', 'no-store');
    this.sendProblem(
      req,
      res,
      307,
      ErrorCode.WRONG_CELL,
      `This institution is served by the ${decision.homeRegion} cell`,
      { homeRegion: decision.homeRegion, apiBaseUrl: decision.apiBaseUrl },
    );
    return true;
  }

  private sendProblem(
    req: Request,
    res: Response,
    status: number,
    code: ErrorCode,
    detail: string,
    extensions: Record<string, unknown>,
  ): void {
    res
      .status(status)
      .type('application/problem+json')
      .json({
        ...extensions,
        type: PROBLEM_TYPE,
        title: STATUS_CODES[status],
        status,
        detail,
        instance: req.originalUrl,
        code,
        traceId: this.cls.isActive() ? this.cls.getId() : 'unknown',
      });
  }
}
