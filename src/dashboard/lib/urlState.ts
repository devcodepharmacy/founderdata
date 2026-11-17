import { useCallback, useEffect, useState } from 'react';

/**
 * Small pieces of page state that live in the URL query, so a refresh, a shared link or an agent's dashboard_url opens
 * the same view: ?tab= (the breakdown and customer tabs), ?view= (a section's sub-view) and ?visitor= (the open
 * visitor). useQueryState owns the period and filters; these helpers leave those alone.
 */

/** Sent after a write here, so every hook that reads the URL reads it again. Back and forward send popstate. */
export const URL_EVENT = 'fd:url';

/** The URL after setting or removing (null) some query parameters, keeping every other one, the path and the hash. */
export function patchSearch(href: string, patch: Record<string, string | null>): string {
  const u = new URL(href, 'http://x');
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  const s = u.searchParams.toString();
  return `${u.pathname}${s ? `?${s}` : ''}${u.hash}`;
}

/** The parts of `window` the URL state uses. Tests pass a stand-in with its own history. */
export type UrlWindow = Pick<Window, 'location' | 'history' | 'dispatchEvent'>;

/** Write query parameters. `push` makes a history entry Back returns from; `replace` changes the current one. */
export function writeSearch(patch: Record<string, string | null>, mode: 'push' | 'replace' = 'replace', state: unknown = null, win: UrlWindow = window) {
  const here = `${win.location.pathname}${win.location.search}${win.location.hash}`;
  const next = patchSearch(here, patch);
  if (next === here) return;
  if (mode === 'push') win.history.pushState(state, '', next);
  else win.history.replaceState(state ?? win.history.state, '', next);
  win.dispatchEvent(new Event(URL_EVENT));
}

/** Opens a visitor's profile as a new history entry, marked so closing it can step back instead. */
export function openVisitor(id: string, win: UrlWindow = window) {
  writeSearch({ visitor: id }, 'push', { fdVisitor: true }, win);
}

/**
 * Closes the profile. One opened here steps back, so Back afterwards leaves the page instead of opening it again. One
 * opened from a link (no entry of ours to return to) drops ?visitor= from the current entry.
 */
export function closeVisitor(win: UrlWindow = window) {
  if ((win.history.state as { fdVisitor?: boolean } | null)?.fdVisitor) win.history.back();
  else writeSearch({ visitor: null }, 'replace', null, win);
}

/** Calls `on` after back, forward and every write through writeSearch or useQueryState. */
export function useUrlChange(on: () => void) {
  useEffect(() => {
    window.addEventListener('popstate', on);
    window.addEventListener(URL_EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener(URL_EVENT, on);
    };
  }, [on]);
}

/** One query parameter, read again whenever the URL changes. */
export function useSearchParam(name: string): string | null {
  const read = () => new URLSearchParams(window.location.search).get(name);
  const [value, setValue] = useState(read);
  useUrlChange(useCallback(() => setValue(read()), [name]));
  return value;
}

/**
 * ?tab= holds the open tab of each card on the page that is not on its first tab, comma separated: "source,changes"
 * is the Referrer tab of the first breakdown and the Changes tab of the customers card. A card's tab is the first entry
 * that is one of its own; tab values are unique across the cards of a page.
 */
export function tabFrom(list: string | null, options: readonly string[]): string | null {
  for (const t of (list ?? '').split(',')) if (t && options.includes(t)) return t;
  return null;
}

/** The ?tab= list after a card switches to `value`. Its first tab (the default) leaves no entry. */
export function withTab(list: string | null, options: readonly string[], value: string): string | null {
  const rest = (list ?? '').split(',').filter((t) => t && !options.includes(t));
  if (value !== options[0]) rest.push(value);
  return rest.length ? rest.join(',') : null;
}

/** A card's open tab, kept in ?tab=. Switching tabs replaces the history entry: Back leaves the page, not the tab. */
export function useUrlTab<T extends string>(options: readonly T[]): [T, (t: T) => void] {
  const list = useSearchParam('tab');
  const tab = (tabFrom(list, options) as T | null) ?? options[0];
  const key = options.join();
  const set = useCallback(
    (t: T) => writeSearch({ tab: withTab(new URLSearchParams(window.location.search).get('tab'), options, t) }),
    // options is a fresh array on each render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [tab, set];
}

/** A section's sub-view in ?view=, `fallback` when absent or unknown. */
export function useUrlView<T extends string>(options: readonly T[], fallback: T): [T, (v: T) => void] {
  const raw = useSearchParam('view');
  const view = raw && (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback((v: T) => writeSearch({ view: v === fallback ? null : v }), [fallback]);
  return [view, set];
}
