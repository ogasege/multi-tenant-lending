import { beforeEach, describe, expect, it } from 'vitest';

import type { TokenPair } from './types';
import { fakeFetch, header } from '../test/fakeFetch';

import { ApiError, createClient } from './api';
import { devLog } from './devlog';

const tokens = (access: string): TokenPair => ({
  accessToken: access,
  tokenType: 'Bearer',
  expiresIn: 900,
  refreshToken: `refresh-${access}`,
  refreshTokenExpiresAt: '2026-12-01T00:00:00Z',
});

describe('api client', () => {
  beforeEach(() => {
    devLog.clear();
  });

  it('sends the Idempotency-Key and records Idempotent-Replayed for the Developer view', async () => {
    const fetchImpl = fakeFetch((url, init) =>
      url === '/cell/af-south-1/v1/loans/L1/disburse' && init.method === 'POST'
        ? {
            body: { id: 'L1', status: 'ACTIVE' },
            headers: { 'Idempotent-Replayed': 'true', RateLimit: '"tenant";r=299;t=60' },
          }
        : undefined,
    );
    let current: TokenPair | null = tokens('a1');
    const api = createClient({
      base: () => '/cell/af-south-1',
      fetchImpl,
      tokens: { get: () => current, set: (t) => (current = t) },
    });

    await api.disburse('L1', 'key-123');

    const init = fetchImpl.mock.calls[0]![1]!;
    expect(header(init, 'Idempotency-Key')).toBe('key-123');
    expect(header(init, 'Authorization')).toBe('Bearer a1');
    const [entry] = devLog.snapshot();
    expect(entry).toMatchObject({
      method: 'POST',
      path: '/v1/loans/L1/disburse',
      status: 200,
      cell: 'af-south-1',
      idempotencyKey: 'key-123',
    });
    expect(entry!.responseHeaders['idempotent-replayed']).toBe('true');
    expect(entry!.responseHeaders.ratelimit).toContain('tenant');
    expect(entry!.replay).not.toBeNull();
  });

  it('throws ApiError with the RFC 9457 problem and redacts secrets in the log', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 401,
      body: { status: 401, code: 'INVALID_CREDENTIALS', title: 'Unauthorized' },
    }));
    const api = createClient({ base: () => '', fetchImpl });
    const err = await api
      .login('eko-medicredit', 'a@b.example', 'S3cret-password')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_CREDENTIALS');
    expect(devLog.snapshot()[0]!.requestBody).toMatchObject({ password: '•••' });
  });

  it('refreshes once on 401 and retries with the rotated token', async () => {
    let current: TokenPair | null = tokens('old');
    const fetchImpl = fakeFetch(
      (url) => (url.endsWith('/v1/auth/refresh') ? { body: tokens('new') } : undefined),
      (url, init) =>
        url.endsWith('/v1/loans') && header(init, 'Authorization') === 'Bearer old'
          ? { status: 401, body: { status: 401, code: 'UNAUTHENTICATED' } }
          : undefined,
      (url) => (url.includes('/v1/loans') ? { body: { items: [], nextCursor: null } } : undefined),
    );
    const api = createClient({
      base: () => '',
      fetchImpl,
      tokens: { get: () => current, set: (t) => (current = t) },
    });
    await expect(api.loans()).resolves.toEqual({ items: [], nextCursor: null });
    expect((current as TokenPair | null)?.accessToken).toBe('new');
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    const api = createClient({
      base: () => '',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(api.branding('x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
