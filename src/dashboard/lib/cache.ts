import { api, ApiError } from './api';

/**
 * The dashboard's answer cache: one entry per request URL, in this tab's memory only. Analytics and revenue never go
 * to localStorage, sessionStorage or the HTTP cache, so a closed tab takes everything with it.
 *
 * - A cached answer renders at once. A mount that finds it older than FRESH_MS revalidates behind it.
 * - Identical requests in flight share one fetch (a URL two components ask for costs one call).
 * - A request nobody waits for any more is aborted, unless prefetch() started it.
 * - Logout (`ml:logout`) and a role change clear everything. A write (POST, PATCH, DELETE) marks every entry stale, so
 *   the next mount refetches while the old answer still shows.
 */

/** Younger than this, a mount does not revalidate. Short, because the numbers move all day. */
const FRESH_MS = 5_000;
/** prefetch() skips a URL answered more recently than this, so hovering a link twice does not call twice. */
const PREFETCH_TTL_MS = 30_000;
/** The most answers kept; the oldest go first. */
const MAX_ENTRIES = 300;

export interface Entry<T = any> {
  /** An answer exists for this URL, so `data` is real (and may be null or empty). */
  has: boolean;
  data: T | undefined;
  error: string | null;
  /** When the answer arrived (ms); 0 once a write marked it stale. */
  ts: number;
  /** A request for this URL is running. */
  inflight: boolean;
}

const EMPTY: Entry = { has: false, data: undefined, error: null, ts: 0, inflight: false };

interface Flight {
  ctrl: AbortController;
  pinned: boolean;
  /** How many writes had happened when the request began. A later write means its answer may predate it. */
  writes: number;
}

const store = new Map<string, Entry>();
const flights = new Map<string, Flight>();
const interest = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
/** Counts writes (markStale). A request that began before the latest one carries an answer that may be old. */
let writes = 0;

/** Requests the page started before any script ran (index.html), keyed by URL. Each is used once. */
declare global {
  interface Window {
    __fdEarly?: Record<string, Promise<Response> | undefined>;
  }
}

let quietTimer: ReturnType<typeof setTimeout> | undefined;
const quietWaiters: (() => void)[] = [];

/**
 * Run `cb` once the dashboard has no request in flight for `settleMs` (the page's waves of requests are done), or
 * after `maxMs` anyway. Speculative downloads wait for this, so they never compete with what is on screen.
 */
export function whenQuiet(cb: () => void, settleMs = 300, maxMs = 6_000) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  quietWaiters.push(run);
  setTimeout(run, maxMs);
  settleQuiet(settleMs);
}

function settleQuiet(settleMs = 300) {
  clearTimeout(quietTimer);
  if (flights.size || !quietWaiters.length) return;
  quietTimer = setTimeout(() => {
    if (!flights.size) for (const run of quietWaiters.splice(0)) run();
  }, settleMs);
}

function notify(url: string) {
  const set = listeners.get(url);
  if (set) for (const cb of [...set]) cb();
}

function put(url: string, entry: Entry) {
  // Re-insert so the Map order is the age order; the oldest entry is the first key.
  store.delete(url);
  store.set(url, entry);
  if (store.size > MAX_ENTRIES) {
    for (const key of store.keys()) {
      if (store.size <= MAX_ENTRIES) break;
      if (!flights.has(key) && !listeners.get(key)?.size) store.delete(key);
    }
  }
  notify(url);
}

export const peek = <T = any>(url: string): Entry<T> => (store.get(url) as Entry<T> | undefined) ?? EMPTY;
export const getSnapshot = peek;

export function subscribe(url: string | null, cb: () => void): () => void {
  if (!url) return () => {};
  let set = listeners.get(url);
  if (!set) listeners.set(url, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(url);
  };
}

/** Use a request index.html started. A 401 there predates a login, so it says nothing: ask again with the session we have now. */
async function fromResponse<T>(early: Promise<Response>, url: string, signal: AbortSignal): Promise<T> {
  const res = await early;
  if (res.status === 401) return api<T>(url, { signal });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

function start(url: string, pinned: boolean): Flight {
  const existing = flights.get(url);
  if (existing) {
    if (pinned) existing.pinned = true;
    return existing;
  }
  const flight: Flight = { ctrl: new AbortController(), pinned, writes };
  flights.set(url, flight);
  clearTimeout(quietTimer);
  const cur = peek(url);
  put(url, { ...cur, error: null, inflight: true });

  const early = window.__fdEarly?.[url];
  if (early) delete window.__fdEarly![url];
  (early ? fromResponse(early, url, flight.ctrl.signal) : api(url, { signal: flight.ctrl.signal })).then(
    (data) => {
      if (flights.get(url) !== flight) return;
      flights.delete(url);
      // An answer to a request that began before a write may not show it: keep it on screen, but count it stale.
      put(url, { has: true, data, error: null, ts: flight.writes < writes ? 0 : Date.now(), inflight: false });
      settleQuiet();
    },
    (err) => {
      if (flights.get(url) !== flight) return;
      flights.delete(url);
      // Keep the last good answer on screen, and say that the refresh failed.
      put(url, { ...peek(url), error: err?.message ?? 'Request failed', inflight: false });
      settleQuiet();
    },
  );
  return flight;
}

function abort(url: string, flight: Flight) {
  if (flights.get(url) !== flight) return;
  flights.delete(url);
  flight.ctrl.abort();
  const cur = peek(url);
  if (cur.inflight) put(url, { ...cur, inflight: false });
}

/**
 * A component wants `url`. Starts a request unless the answer is fresh or one is running, and returns the release
 * function for the effect cleanup. `force` (a reload key moved) skips the freshness check.
 */
export function acquire(url: string, force: boolean): () => void {
  const entry = store.get(url);
  const fresh = !!entry?.has && !entry.error && Date.now() - entry.ts < FRESH_MS;
  const running = flights.get(url);
  if (running && running.writes < writes) {
    // The request began before the last write, so its answer may predate it: a mount or a reload wants one that does not.
    abort(url, running);
    start(url, false);
  } else if (!running && (force || !fresh)) start(url, false);
  interest.set(url, (interest.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (interest.get(url) ?? 1) - 1;
    if (left > 0) return void interest.set(url, left);
    interest.delete(url);
    // StrictMode and quick URL changes unmount and remount in the same tick: wait one before aborting.
    setTimeout(() => {
      const flight = flights.get(url);
      if (flight && !flight.pinned && !interest.get(url)) abort(url, flight);
    }, 0);
  };
}

/** Warm the cache for a URL the person is likely to open next. No component waits, so nothing aborts it. */
export function prefetch(url: string): void {
  if (flights.has(url)) return;
  const entry = store.get(url);
  if (entry?.has && Date.now() - entry.ts < PREFETCH_TTL_MS) return;
  start(url, true);
}

/** Replace the cached answer (a save returned the new state), keeping every component on this URL in step. */
export function setCached<T>(url: string, value: T | null | ((prev: T | null) => T | null)) {
  const cur = peek<T>(url);
  const next = typeof value === 'function' ? (value as (p: T | null) => T | null)(cur.has ? (cur.data as T) : null) : value;
  put(url, next === null ? { ...cur, has: false, data: undefined } : { ...cur, has: true, data: next, ts: Date.now() });
}

/** Drop everything: logout, another role, a failed session. Running requests abort. */
export function clearCache() {
  window.__fdEarly = undefined;
  for (const [url, flight] of [...flights]) {
    flights.delete(url);
    flight.ctrl.abort();
  }
  const urls = new Set([...store.keys(), ...listeners.keys()]);
  store.clear();
  for (const url of urls) notify(url);
}

/** A write happened: every cached answer is now a stale one, shown until the next mount refetches it. */
export function markStale() {
  writes++;
  // In place and silent: nothing on screen shows the age, so no component needs to render again.
  for (const entry of store.values()) entry.ts = 0;
}

if (typeof window !== 'undefined') {
  window.addEventListener('ml:logout', clearCache);
  window.addEventListener('fd:role-changed', clearCache);
  window.addEventListener('fd:wrote', markStale);
}
