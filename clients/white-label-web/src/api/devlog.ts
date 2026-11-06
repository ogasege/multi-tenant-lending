/**
 * In-memory log of every HTTP exchange, rendered by the Developer view. Secrets are redacted
 * before they are stored, so the panel can be shown on screen during a demo.
 */

export interface Exchange {
  id: number;
  at: string;
  method: string;
  path: string;
  url: string;
  cell: string;
  status: number;
  durationMs: number;
  idempotencyKey: string | null;
  requestBody: unknown;
  responseBody: unknown;
  /** Headers worth showing: Idempotent-Replayed, RateLimit, X-Request-ID, X-Tenant-Cell… */
  responseHeaders: Record<string, string>;
  /** The client resent this request to an allow-listed cell (e.g. a 307 to the home cell). */
  redirectedTo: string | null;
  /** The client refused to follow this redirect, and why ("Cell routing refused"). */
  routingRefused: string | null;
  /** Re-sends the exact request (same body, same Idempotency-Key). */
  replay: (() => Promise<unknown>) | null;
}

export const SHOWN_HEADERS = [
  'idempotent-replayed',
  'ratelimit',
  'ratelimit-policy',
  'retry-after',
  'x-request-id',
  'x-tenant-cell',
  'location',
  'content-type',
] as const;

const SECRET_KEYS = /^(password|nationalid|accesstoken|refreshtoken|token|secret)$/i;

/** Deep copy with secret-looking fields replaced by a mask. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) && typeof v === 'string' ? '•••' : redact(v),
      ]),
    );
  }
  return value;
}

type Listener = () => void;

const MAX_ENTRIES = 50;
let entries: readonly Exchange[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

export const devLog = {
  add: (entry: Omit<Exchange, 'id'>): Exchange => {
    const full = { ...entry, id: nextId++ };
    entries = [full, ...entries].slice(0, MAX_ENTRIES);
    listeners.forEach((l) => {
      l();
    });
    return full;
  },
  clear: (): void => {
    entries = [];
    listeners.forEach((l) => {
      l();
    });
  },
  snapshot: (): readonly Exchange[] => {
    return entries;
  },
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
