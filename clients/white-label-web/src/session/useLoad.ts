import { useCallback, useEffect, useState, type DependencyList } from 'react';

import { describeError, type FriendlyError } from '../i18n/errors';

export interface Loaded<T> {
  data: T | null;
  error: FriendlyError | null;
  /** True until the first response (data stays on screen during later reloads). */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data on mount, when `deps` change and on `reload()`; optional polling. Responses of
 * a superseded run are dropped.
 */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  locale: string,
  pollMs?: number,
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const run = { stale: false };
    loader().then(
      (value) => {
        if (run.stale) return;
        setData(value);
        setError(null);
      },
      (err: unknown) => {
        if (!run.stale) setError(describeError(err, locale));
      },
    );
    return () => {
      run.stale = true;
    };
    // `loader` is recreated every render; `deps` says when it really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, locale]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, pollMs);
    return () => {
      clearInterval(timer);
    };
  }, [pollMs]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return { data, error, loading: data === null && error === null, reload };
}
