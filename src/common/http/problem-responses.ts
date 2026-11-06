import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

const DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed (RFC 9457 problem details with `errors[]`)',
  401: 'Missing, invalid or expired credentials',
  403: 'Authenticated but not allowed',
  404: 'Not found (also returned for other tenants’ resources)',
  409: 'Conflict with existing state (e.g. DUPLICATE)',
  421: 'Credential issued by another cell (MISDIRECTED_REQUEST, with `homeRegion`/`apiBaseUrl`)',
  422: 'Business rule violated',
  423: 'Account temporarily locked after repeated failed sign-ins',
  429: 'Rate limit exceeded',
};

const PROBLEM_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    traceId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
  required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'traceId'],
};

/** Documents the `application/problem+json` error responses a route can return. */
export const ApiProblemResponses = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? 'Error',
        content: { 'application/problem+json': { schema: PROBLEM_SCHEMA } },
      }),
    ),
  );
