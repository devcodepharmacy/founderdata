import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { acquire, peek, setCached, subscribe } from './cache';

export { prefetch } from './cache';

/**
 * Fetch `url` whenever it changes (or `reloadKey` bumps). `null` skips fetching.
 *
 * Answers come from the tab's cache (lib/cache.ts): a cached one renders on the first pass and is revalidated behind
 * it, and two components asking for one URL share one request. When `url` changes, the previous answer stays in `data`
 * until the new one lands, so a period or filter change dims the page instead of blanking it.
 *
 * - `data`: the answer for `url`, or the last answer for an earlier URL while the new one loads, or null.
 * - `loading`: no answer for `url` yet and a request is on its way (or about to start). The old signal for dimming.
 * - `isRefreshing`: an answer for `url` is on screen and a request revalidates it. Show nothing, or a hairline.
 * - `isStale`: `data` belongs to an earlier URL. Dim it.
 * - `outdated`: a write happened since `data` arrived and nothing has re-asked yet (or is asking now). `data` may miss
 *   what the write added, so do not conclude from it that something does not exist.
 * - `error`: the message of the last failed request for `url`; `data` keeps the last good answer.
 * - `setData`: replace the cached answer, for a save that returns the new state.
 */
export function useApi<T>(url: string | null, reloadKey = 0) {
  const sub = useCallback((cb: () => void) => subscribe(url, cb), [url]);
  const snap = () => (url ? peek<T>(url) : peek<T>('\0'));
  const entry = useSyncExternalStore(sub, snap, snap);
  const kept = useRef<T | null>(null);
  const last = useRef<{ url: string | null; key: number } | null>(null);

  useEffect(() => {
    if (!url) {
      last.current = null;
      return;
    }
    // The same URL with a new reload key is a reload someone asked for: skip the freshness check.
    const force = last.current?.url === url && last.current.key !== reloadKey;
    last.current = { url, key: reloadKey };
    return acquire(url, force);
  }, [url, reloadKey]);

  if (entry.has) kept.current = entry.data as T;
  const data = entry.has ? (entry.data as T) : kept.current;
  const setData = useCallback(
    (v: T | null | ((prev: T | null) => T | null)) => {
      if (url) setCached<T>(url, v);
    },
    [url],
  );
  return {
    data,
    error: url ? entry.error : null,
    loading: !!url && !entry.has && !entry.error,
    isRefreshing: !!url && entry.has && entry.inflight,
    isStale: !!url && !entry.has && data !== null,
    outdated: !!url && entry.has && !entry.error && (entry.ts === 0 || entry.inflight),
    setData,
  };
}
