import { vi } from 'vitest';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = (url: string, init: RequestInit) => FakeResponse | undefined;

/** A fetch double: the first route returning a response wins; others are 404 problems. */
export function fakeFetch(...routes: Route[]) {
  return vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const route of routes) {
      const r = route(url, init);
      if (r) {
        const status = r.status ?? 200;
        return Promise.resolve(
          new Response(r.body === undefined ? null : JSON.stringify(r.body), {
            status,
            headers: { 'content-type': 'application/json', ...r.headers },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND' }), { status: 404 }),
    );
  });
}

export const header = (init: RequestInit, name: string): string | null =>
  new Headers(init.headers).get(name);
