import { useCallback, useEffect, useState, type DependencyList } from 'react';

import { describeError, type FriendlyError } from '../i18n/errors';

export interface Loaded<T> {
  data: T | null;
  /**
   * The last failure. Data from an earlier success stays on screen, so a page that has data
   * must still show this error: otherwise a failing refresh silently freezes a stale view.
   */
  error: FriendlyError | null;
  /** True until the first response (data stays on screen during later reloads). */
  loading: boolean;
  /** True while the poll is running (polling requested and `until` not yet met). */
  polling: boolean;
  reload: () => void;
}

export interface Polling<T> {
  /** Interval between refreshes. */
  everyMs: number;
  /** Stops polling once the loaded data reaches a final state. */
  until?: (data: T) => boolean;
}

/**
 * Loads data on mount, when `deps` change and on `reload()`; optional polling, which also
 * refreshes at once when the window regains focus or becomes visible (browsers throttle timers
 * in background windows). Responses of a superseded run are dropped.
 *
 * Data is not cleared when `deps` change: a page showing one record per route id should be
 * keyed by that id (see `KeyedById` in App.tsx) so another record never renders stale data.
 */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  locale: string,
  poll?: Polling<T>,
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

  const settled = data !== null && (poll?.until?.(data) ?? false);
  const everyMs = settled ? undefined : poll?.everyMs;

  useEffect(() => {
    if (!everyMs) return;
    const refresh = () => {
      setTick((n) => n + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(refresh, everyMs);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [everyMs]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return {
    data,
    error,
    loading: data === null && error === null,
    polling: everyMs !== undefined,
    reload,
  };
}
