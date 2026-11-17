import { useCallback, useRef, useState } from 'react';
import type { Filters, Query } from './api';
import { URL_EVENT, useUrlChange, type UrlWindow } from './urlState';

/** Period, granularity and filters live in the URL so a refresh or shared link keeps them. */
export function readQuery(search: string = window.location.search): Query {
  const p = new URLSearchParams(search);
  let filters: Filters = {};
  try {
    filters = JSON.parse(p.get('filters') || '{}');
  } catch {}
  return {
    period: p.get('period') || '30d',
    from: p.get('from') || undefined,
    to: p.get('to') || undefined,
    granularity: p.get('granularity') || undefined,
    filters,
  };
}

/** The query after a change: a period other than custom drops the custom days. */
export function nextQuery(prev: Query, patch: Partial<Query>): Query {
  const next = { ...prev, ...patch };
  if (patch.period && patch.period !== 'custom') {
    next.from = undefined;
    next.to = undefined;
  }
  return next;
}

const sameFilters = (a: Query['filters'], b: Query['filters']) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The URL for a query and whether it is a new history entry. A filter change pushes one, so Back removes the filter
 * again; a period or granularity change replaces the current one. Other parameters (?tab=, ?view=, ?visitor=) stay.
 */
export function queryHref(prev: Query, next: Query, search: string, pathname: string): { url: string; push: boolean } {
  const p = new URLSearchParams(search);
  for (const k of ['period', 'from', 'to', 'granularity', 'filters']) p.delete(k);
  const own = new URLSearchParams();
  own.set('period', next.period);
  if (next.from) own.set('from', next.from);
  if (next.to) own.set('to', next.to);
  if (next.granularity) own.set('granularity', next.granularity);
  if (Object.keys(next.filters).length) own.set('filters', JSON.stringify(next.filters));
  for (const [k, v] of p) own.append(k, v);
  return { url: `${pathname}?${own}`, push: !sameFilters(prev.filters, next.filters) };
}

/** A copy of the current search with one more filter, for a link into another section (ASA row to the App tab). */
export function searchWithFilter(search: string, key: string, value: string): string {
  const q = readQuery(search);
  return queryHref(q, { ...q, filters: { ...q.filters, [key]: value } }, search, '').url;
}

/**
 * Writes a query change to the URL and returns the new query: a filter change is a new history entry, a period or
 * grouping change replaces the current one. The caller sends URL_EVENT once its own state holds the new query.
 */
export function applyQuery(prev: Query, patch: Partial<Query>, win: UrlWindow = window): Query {
  const next = nextQuery(prev, patch);
  const { url, push } = queryHref(prev, next, win.location.search, win.location.pathname);
  if (push) win.history.pushState(null, '', url);
  else win.history.replaceState(win.history.state, '', url);
  return next;
}

/** The query after Back, Forward or a write elsewhere: `prev` itself when the URL still says the same, so nothing reloads. */
export function queryFromUrl(prev: Query, search: string): Query {
  const next = readQuery(search);
  return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
}

export function useQueryState() {
  const [q, setQ] = useState<Query>(() => readQuery());
  const current = useRef(q);
  current.current = q;

  // Back and forward, and writes from elsewhere. An unchanged query keeps its object, so nothing reloads.
  useUrlChange(
    useCallback(() => {
      const next = queryFromUrl(current.current, window.location.search);
      if (next !== current.current) setQ(next);
    }, []),
  );

  const update = useCallback((patch: Partial<Query>) => {
    // Outside the state setter: React may call a setter twice, and a push must happen once.
    const next = applyQuery(current.current, patch);
    current.current = next;
    setQ(next);
    window.dispatchEvent(new Event(URL_EVENT));
  }, []);

  return [q, update] as const;
}
