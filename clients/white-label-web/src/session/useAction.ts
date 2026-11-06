import { useCallback, useRef, useState } from 'react';

import { describeError, type FriendlyError } from '../i18n/errors';

export interface ActionState<T> {
  pending: boolean;
  error: FriendlyError | null;
  result: T | null;
  /** The Idempotency-Key the next attempt will send (kept after a failure). */
  key: string | null;
}

/**
 * Runs one user action with an Idempotency-Key. The key is created on the first attempt and
 * REUSED on every retry until the action succeeds: a retry after a timeout can never pay
 * twice, and a failed attempt (rolled back server-side, SPEC §9) frees the key for the
 * corrected request. A new key is drawn only for the next, distinct action.
 */
export function useIdempotentAction<A extends unknown[], T>(
  fn: (key: string, ...args: A) => Promise<T>,
  locale: string,
) {
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<ActionState<T>>({
    pending: false,
    error: null,
    result: null,
    key: null,
  });

  const run = useCallback(
    async (...args: A): Promise<T | null> => {
      keyRef.current ??= crypto.randomUUID();
      const key = keyRef.current;
      setState((s) => ({ ...s, pending: true, error: null, key }));
      try {
        const result = await fn(key, ...args);
        keyRef.current = null;
        setState({ pending: false, error: null, result, key });
        return result;
      } catch (err) {
        setState({ pending: false, error: describeError(err, locale), result: null, key });
        return null;
      }
    },
    [fn, locale],
  );

  const reset = useCallback(() => {
    keyRef.current = null;
    setState({ pending: false, error: null, result: null, key: null });
  }, []);

  return { ...state, run, reset };
}

/** Same as above for non-idempotent calls (reads, assess, reject). */
export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>, locale: string) {
  const [state, setState] = useState<Omit<ActionState<T>, 'key'>>({
    pending: false,
    error: null,
    result: null,
  });
  const run = useCallback(
    async (...args: A): Promise<T | null> => {
      setState((s) => ({ ...s, pending: true, error: null }));
      try {
        const result = await fn(...args);
        setState({ pending: false, error: null, result });
        return result;
      } catch (err) {
        setState({ pending: false, error: describeError(err, locale), result: null });
        return null;
      }
    },
    [fn, locale],
  );
  return { ...state, run };
}
