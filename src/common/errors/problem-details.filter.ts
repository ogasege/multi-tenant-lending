import { STATUS_CODES } from 'node:http';

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';

import { AppError } from './app-error';
import { ErrorCode } from './error-codes';

/**
 * RFC 9457 `type` for every problem. `about:blank` means the HTTP status says what kind of
 * problem it is; the stable machine-readable reason is the `code` extension.
 */
export const PROBLEM_TYPE = 'about:blank';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  traceId: string;
  [extension: string]: unknown;
}

const HTTP_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.VALIDATION_FAILED,
  429: ErrorCode.RATE_LIMITED,
};

const INTERNAL_DETAIL = 'An unexpected error occurred';

/**
 * Renders every error as RFC 9457 `application/problem+json` with a stable `code` and the
 * request's `traceId`. Unexpected errors are logged with their stack and returned as a generic
 * 500 — internals never leak to clients.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const problem = this.toProblem(exception, req);
    // 429s raised outside the rate-limit guards (e.g. the per-tenant sign-up budget).
    if (
      problem.status === 429 &&
      typeof problem.retryAfterSeconds === 'number' &&
      !res.getHeader('Retry-After')
    ) {
      res.setHeader('Retry-After', String(problem.retryAfterSeconds));
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, req: Request): ProblemDetails {
    const base = {
      instance: req.originalUrl,
      traceId: this.cls.isActive() ? this.cls.getId() : 'unknown',
    };

    if (exception instanceof AppError) {
      return {
        // Extensions first: they can never overwrite the core problem fields.
        ...exception.details,
        ...base,
        ...problemFields(exception.status, exception.code, exception.message),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_CODE[status] ?? ErrorCode.INTERNAL_ERROR;
      const detail = status >= 500 ? INTERNAL_DETAIL : exception.message;
      return { ...base, ...problemFields(status, code, detail) };
    }

    if (isPgError(exception) && exception.code === '23505') {
      // Unique violation that escaped the use case (e.g. a race on a natural key).
      return {
        ...base,
        ...problemFields(
          409,
          ErrorCode.DUPLICATE,
          'A resource with the same unique attributes already exists',
        ),
      };
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return { ...base, ...problemFields(500, ErrorCode.INTERNAL_ERROR, INTERNAL_DETAIL) };
  }
}

/** Problem members derived from the error itself; `type` is the docs URL for `code`. */
function problemFields(
  status: number,
  code: ErrorCode,
  detail: string,
): Pick<ProblemDetails, 'type' | 'title' | 'status' | 'detail' | 'code'> {
  return {
    type: PROBLEM_TYPE,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    code,
  };
}

function isPgError(err: unknown): err is { code: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string';
}
