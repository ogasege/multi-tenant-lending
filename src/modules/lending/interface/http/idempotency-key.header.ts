import { ApiHeader } from '@nestjs/swagger';

/** OpenAPI doc of the `Idempotency-Key` header required by every `@Idempotent()` route. */
export const IDEMPOTENCY_HEADER = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: '8–255 chars [A-Za-z0-9_-]; replays return the first response',
});
