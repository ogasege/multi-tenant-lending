import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/api';

import { useIdempotentAction } from './useAction';

describe('useIdempotentAction', () => {
  it('reuses the same key on retry and draws a new one after success', async () => {
    const seen: string[] = [];
    const fn = vi
      .fn<(key: string) => Promise<string>>()
      .mockImplementationOnce((key) => {
        seen.push(key);
        return Promise.reject(new ApiError({ status: 0, code: 'NETWORK_ERROR' }));
      })
      .mockImplementation((key) => {
        seen.push(key);
        return Promise.resolve('ok');
      });
    const { result } = renderHook(() => useIdempotentAction(fn, 'en-NG'));

    await act(() => result.current.run());
    expect(result.current.error?.code).toBe('NETWORK_ERROR');
    await act(() => result.current.run());
    expect(result.current.result).toBe('ok');
    await act(() => result.current.run());

    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
