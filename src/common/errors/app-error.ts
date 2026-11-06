import { ErrorCode } from './error-codes';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Base class for every expected (non-bug) failure. Carries an HTTP status and a stable code;
 * the global filter renders it as RFC 9457 problem details. Domain code throws these instead
 * of NestJS HttpExceptions so the domain stays framework-agnostic.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: { errors?: FieldError[]; [key: string]: unknown },
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, errors?: FieldError[]) {
    super(400, ErrorCode.VALIDATION_FAILED, message, errors ? { errors } : undefined);
  }
}

/** A well-formed request that breaks a business rule (422 Unprocessable Content). */
export class BusinessRuleError extends AppError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(422, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(
      404,
      ErrorCode.NOT_FOUND,
      id ? `${entity} ${id} was not found` : `${entity} was not found`,
    );
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class InvalidStateTransitionError extends ConflictError {
  constructor(entity: string, from: string, action: string) {
    super(ErrorCode.INVALID_STATE_TRANSITION, `Cannot ${action} a ${entity} in status ${from}`, {
      entity,
      from,
      action,
    });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(code: ErrorCode = ErrorCode.UNAUTHENTICATED, message = 'Authentication required') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code: ErrorCode = ErrorCode.FORBIDDEN, message = 'You are not allowed to do this') {
    super(403, code, message);
  }
}

/**
 * 421 Misdirected Request (RFC 9110 §15.5.20): the access token was issued by another cell,
 * whose data this cell does not hold. Carries the token's home region and, when the tenant
 * directory knows it, that cell's API base URL so the client can retry there.
 */
export class MisdirectedRequestError extends AppError {
  constructor(
    readonly homeRegion: string,
    readonly apiBaseUrl?: string,
  ) {
    super(
      421,
      ErrorCode.MISDIRECTED_REQUEST,
      `This credential was issued by the ${homeRegion} cell; send the request there`,
      apiBaseUrl ? { homeRegion, apiBaseUrl } : { homeRegion },
    );
  }
}
