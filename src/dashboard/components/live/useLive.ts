import { useCallback, useEffect, useRef, useState } from 'react';
import { parseLive } from './adapter';
import type { LiveData, LiveState } from './types';

/** How often the live view asks the server while the tab is visible. */
export const LIVE_POLL_MS = 12_000;
/** The demo moves faster than the server would, so a short look shows arrivals and a payment. */
const DEMO_TICK_MS = 2_500;
const MAX_BACKOFF_MS = 120_000;
/** The 24-hour places change slowly and cost the server the most rows, so they are asked for this often. */
export const PLACES_EVERY_MS = 5 * 60_000;

const NO_WINDOW = { places: [], recent: [], recentCount: 0, recentSites: [], recentRevenue: [], recentEvents: [], recentAt: null } satisfies Partial<LiveData>;

/**
 * The demo answers for a whole day. This keeps the share of a shorter window: its visitors, their count per site, and
 * its events with their money.
 */
export function cutToWindow(data: LiveData, minutes: number): LiveData {
  const since = data.now - minutes * 60_000;
  const recent = data.recent.filter((v) => v.lastSeenAt > since);
  // The demo's list is cut at 150 like the server's, oldest dropped. A window that holds the whole list is scaled up
  // by what the cut left out; a shorter one has all of its visitors in the list.
  const scale = recent.length && recent.length === data.recent.length ? Math.max(1, data.recentCount / recent.length) : 1;
  const listed = (id: string) => recent.filter((v) => v.siteId === id).length;
  const recentEvents = data.recentEvents.filter((e) => e.ts > since);
  const by = new Map<string, { currency: string; amount: number; payments: number }>();
  for (const e of recentEvents) {
    if (e.kind !== 'payment' || e.amount == null || !e.currency) continue;
    const r = by.get(e.currency) ?? { currency: e.currency, amount: 0, payments: 0 };
    by.set(e.currency, { ...r, amount: r.amount + e.amount, payments: r.payments + 1 });
  }
  const recentSites = data.recentSites.map((s) => ({ ...s, visitors: Math.round(listed(s.id) * scale) })).filter((s) => s.visitors > 0);
  return {
    ...data,
    recent,
    recentSites,
    recentCount: recentSites.reduce((n, s) => n + s.visitors, 0),
    recentEvents: recentEvents.slice(0, 30),
    recentRevenue: [...by.values()].sort((a, b) => b.amount - a.amount),
  };
}

/** The poll URL: places only when they are due (docs/MOBILE-API.md section 9, `?places=0`), for the given window. */
export function liveUrl(base: string, withPlaces: boolean, placesMinutes?: number | null): string {
  const join = base.includes('?') ? '&' : '?';
  if (!withPlaces) return base + join + 'places=0';
  return placesMinutes ? base + join + `placesMinutes=${placesMinutes}` : base;
}

/** True when the page URL carries ?demo=1 (or ?demo, ?demo=true). */
export function demoRequested(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  const v = new URLSearchParams(search).get('demo');
  return v !== null && v !== '0' && v !== 'false';
}

/**
 * Polls GET /api/live?places=0 every 12 s while the tab is visible. With `placesMinutes` it also asks for the places
 * and the recent visitors of that window on the first call and every 5 minutes after (every minute for windows under
 * an hour), keeping the last ones in between; without it (null, the default) it never asks for them and
 * `data.places` and `data.recent` stay empty. It stops while the tab is hidden and asks again
 * the moment the tab comes back. A failed poll keeps the last answer (marked stale) and waits longer each time, up to two minutes.
 * A 404 means the server is older than this dashboard: polling stops and the view says so.
 * With `demo` (default: ?demo=1 in the URL) it plays the built-in fixture and makes no request at all.
 */
export function useLive(opts: { demo?: boolean; url?: string; placesMinutes?: number | null } = {}): LiveState {
  const demo = opts.demo ?? demoRequested();
  const url = opts.url ?? '/api/live';
  const placesMinutes = opts.placesMinutes ?? null;
  const [state, setState] = useState<Omit<LiveState, 'refresh' | 'demo'>>({ status: 'loading', data: null, stale: false, updatedAt: null });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let inflight: AbortController | null = null;
    let snapshot: ((now?: number) => unknown) | null = null;
    let stopped = false;
    // The last places the server sent, kept for the polls that leave them out.
    let places: LiveData['places'] | null = null;
    let kept: Pick<LiveData, 'recent' | 'recentCount' | 'recentSites' | 'recentRevenue' | 'recentEvents' | 'recentAt'> | null = null;
    let placesAt = -Infinity;

    const accept = (data: LiveData) => {
      failures = 0;
      setState({ status: 'ready', data, stale: false, updatedAt: Date.now() });
    };

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!alive || stopped) return;
      timer = setTimeout(tick, ms);
    };

    async function tick() {
      clearTimeout(timer);
      if (!alive || stopped) return;
      // A hidden tab does not poll; the visibility listener restarts it.
      if (document.hidden) return;
      if (demo) {
        if (!snapshot) snapshot = (await import('./demo')).createDemo();
        if (!alive) return;
        const data = parseLive(snapshot(Date.now()));
        accept(placesMinutes ? cutToWindow(data, placesMinutes) : { ...data, ...NO_WINDOW });
        return schedule(DEMO_TICK_MS);
      }
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const every = placesMinutes !== null && placesMinutes < 60 ? 60_000 : PLACES_EVERY_MS;
        const withPlaces = placesMinutes !== null && (places === null || Date.now() - placesAt >= every);
        const res = await fetch(liveUrl(url, withPlaces, placesMinutes), { credentials: 'include', signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!alive) return;
        if (res.status === 404) {
          stopped = true;
          setState({ status: 'unsupported', data: null, stale: false, updatedAt: null });
          return;
        }
        if (res.status === 401) window.dispatchEvent(new Event('ml:logout'));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw: { places?: unknown } | null = await res.json();
        const data = parseLive(raw);
        if (raw && Array.isArray(raw.places)) {
          places = data.places;
          kept = { recent: data.recent, recentCount: data.recentCount, recentSites: data.recentSites, recentRevenue: data.recentRevenue, recentEvents: data.recentEvents, recentAt: data.recentAt };
          placesAt = Date.now();
        } else if (places) {
          data.places = places;
          Object.assign(data, kept);
        }
        accept(data);
        schedule(LIVE_POLL_MS);
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return;
        failures++;
        setState((s) => (s.data ? { ...s, stale: true } : { ...s, status: 'error' }));
        schedule(Math.min(MAX_BACKOFF_MS, LIVE_POLL_MS * 2 ** Math.min(failures, 4)));
      } finally {
        if (inflight === ctrl) inflight = null;
      }
    }

    const onVisible = () => {
      if (document.hidden) clearTimeout(timer);
      else tick();
    };
    kick.current = () => {
      stopped = false;
      failures = 0;
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      inflight?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [demo, url, placesMinutes]);

  const refresh = useCallback(() => kick.current(), []);
  return { ...state, demo, refresh };
}
