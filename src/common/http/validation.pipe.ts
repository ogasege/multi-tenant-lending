import { type ValidationError as ClassValidationError, ValidationPipe } from '@nestjs/common';

import { type FieldError, ValidationError } from '../errors/app-error';

function flatten(errors: ClassValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/**
 * Strict DTO validation (OWASP API3 — mass assignment): unknown properties are rejected, not
 * silently dropped, so a client can never smuggle `status`, `tenantId` or similar fields.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => new ValidationError('Request validation failed', flatten(errors)),
  });
}
