// Search Console arithmetic shared by the dashboard's SEO and Content tabs (pro/dashboard/lib/seo.ts re-exports it)
// and the read API's /api/v1/seo/decay and /api/v1/seo/opportunities (pro/worker/seo-api.ts), so both give the same
// numbers. Pure functions over the snapshot's per-day rows (docs/SEO.md); no I/O.

/** [date, clicks, impressions, position] */
export type GscDay = [string, number, number, number | null];
/** [date, query or page, clicks, impressions, position] */
export type GscRow = [string, string, number, number, number | null];

const DAY = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

export interface Win {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

/** `days` days ending on the last day Search Console has, and the same number of days before them. */
export function windowEnding(last: string, days: number): Win {
  const from = addDays(last, -(days - 1));
  return { from, to: last, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number | null;
  /** Impression-weighted average position, as Search Console computes it. Null without impressions. */
  position: number | null;
  /** Days in the window that have a row. */
  days: number;
}

export function total(rows: { clicks: number; impressions: number; position: number | null }[], days: number): Totals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    if (r.position !== null && r.impressions > 0) weighted += r.position * r.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? weighted / impressions : null, days };
}

export interface KeyRow extends Totals {
  key: string;
  prev: Totals | null;
}

/** Query or page rows summed per key over the window, with the previous window beside each. Most clicks first. */
export function byKey(rows: GscRow[], w: Win): KeyRow[] {
  const cur = new Map<string, GscRow[]>();
  const prev = new Map<string, GscRow[]>();
  for (const r of rows) {
    const m = r[0] >= w.from && r[0] <= w.to ? cur : r[0] >= w.prevFrom && r[0] <= w.prevTo ? prev : null;
    if (!m) continue;
    const list = m.get(r[1]);
    if (list) list.push(r);
    else m.set(r[1], [r]);
  }
  const sum = (list: GscRow[]) => total(list.map((r) => ({ clicks: r[2], impressions: r[3], position: r[4] })), new Set(list.map((r) => r[0])).size);
  return [...cur.entries()]
    .map(([key, list]) => ({ key, ...sum(list), prev: prev.has(key) ? sum(prev.get(key)!) : null }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key));
}

/** The last day the rows have, as `YYYY-MM-DD`, or null for no rows. */
export function lastDay(rows: { 0: string }[]): string | null {
  let last: string | null = null;
  for (const r of rows) if (last === null || r[0] > last) last = r[0];
  return last;
}

/**
 * An http(s) URL whose path `new URL` would give back unchanged: a plain host, and a path of characters URL parsing
 * neither encodes nor resolves (no `/.` segment). The sync maps thousands of page keys a run, and this skips the parser.
 */
const PLAIN_URL = /^https?:\/\/[A-Za-z0-9.\-:]+(\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*)?(?:[?#]|$)/;

/** A Search Console page key as the path FounderData stores for entry pages: `https://acme.example/blog/x?y` is `/blog/x`. */
export function pagePath(key: string): string {
  if (key.startsWith('/')) return key.replace(/[?#].*$/, '') || '/';
  const plain = PLAIN_URL.exec(key);
  if (plain && !(plain[1] ?? '').includes('/.')) return plain[1] || '/';
  try {
    return new URL(key).pathname || '/';
  } catch {
    return key;
  }
}

/**
 * A rough click-through rate by Google position for organic results, from published CTR studies (position 1 near
 * 28%, page two near 1%). Only good for spotting a page far below it, never for a target.
 */
export function expectedCtr(position: number): number {
  const curve = [0.28, 0.15, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.022];
  if (position < 1) return curve[0];
  if (position <= 10) return curve[Math.round(position) - 1];
  if (position <= 20) return 0.01;
  return 0.004;
}

/** The impressions a query or page needs in a window of `days` to count as an opportunity: 20 and 50 for 28 days. */
export function opportunityMinimums(days: number) {
  return { queries: Math.max(5, Math.round((days / 28) * 20)), pages: Math.max(10, Math.round((days / 28) * 50)) };
}

/** Queries at an average position of 5 to 20 with enough impressions to be worth a section: most impressions first. */
export function strikingDistance(queries: KeyRow[], minImpressions: number): KeyRow[] {
  return queries
    .filter((q) => q.position !== null && q.position >= 4.5 && q.position <= 20.5 && q.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions);
}

/** Pages on page one whose click-through rate is under half the rough curve: their title and description lose the click. */
export function lowCtrPages(pages: KeyRow[], minImpressions: number): (KeyRow & { expected: number })[] {
  return pages
    .filter((p) => p.position !== null && p.position <= 10.5 && p.impressions >= minImpressions && p.ctr !== null)
    .map((p) => ({ ...p, expected: expectedCtr(p.position!) }))
    .filter((p) => p.ctr! < p.expected / 2)
    .sort((a, b) => b.impressions * (b.expected - b.ctr!) - a.impressions * (a.expected - a.ctr!));
}

/** The position a striking-distance query is measured against for its clicks to gain. */
export const STRIKING_TARGET_POSITION = 3;

/**
 * Clicks a window would have had at the expected click-through rate, minus the clicks it had: at position 3 for a
 * query close to page one, at its own position for a page-one page with a low click-through rate. Never below 0.
 */
export function clicksToGain(row: Totals, atPosition: number): number {
  return Math.max(0, Math.round(row.impressions * expectedCtr(atPosition) - row.clicks));
}

export interface Opportunities {
  minimums: { queries: number; pages: number };
  queries: (KeyRow & { gain: number })[];
  pages: (KeyRow & { expected: number; gain: number })[];
}

/** Both opportunity lists for one window, each ranked by clicks to gain. */
export function opportunities(queries: KeyRow[], pages: KeyRow[], days: number): Opportunities {
  const minimums = opportunityMinimums(days);
  const byGain = <T extends { gain: number; impressions: number; key: string }>(a: T, b: T) => b.gain - a.gain || b.impressions - a.impressions || a.key.localeCompare(b.key);
  return {
    minimums,
    queries: strikingDistance(queries, minimums.queries)
      .map((q) => ({ ...q, gain: clicksToGain(q, STRIKING_TARGET_POSITION) }))
      .sort(byGain),
    pages: lowCtrPages(pages, minimums.pages)
      .map((p) => ({ ...p, gain: clicksToGain(p, p.position!) }))
      .sort(byGain),
  };
}

/** What counts as a decaying page: clicks down more than `minDrop` against the window before, from at least `minPrevClicks`. */
export const DECAY = { days: 28, minPrevClicks: 10, minDrop: 0.3 } as const;

export interface DecayRow {
  /** The page as Search Console names it. */
  key: string;
  cur: Totals;
  prev: Totals;
  clicksLost: number;
  /** The change in clicks as a fraction: -0.42 is 42% fewer. */
  change: number;
  /** Clicks per 7 days over both windows, oldest first, the last bucket ending on the window's last day. */
  weekly: number[];
}

/**
 * Each page's clicks in the window ending on `last` (`cur`) and the pages of the window before (`before`), from the full
 * page totals when given, else from the daily rows. A page with no row in the last window lost every click, so the
 * list starts from the window before.
 */
export function decayBase(rows: GscRow[], last: string, days: number, totals: GscTotals | null) {
  const w = windowEnding(totals ? totals.to : last, days);
  if (totals) {
    const all = totalsByKey(totals, pagePath);
    return { w, cur: new Map<string, Totals>(all.map((k) => [k.key, k])), before: all.filter((k) => k.prev).map((k) => ({ key: k.key, ...k.prev! })) };
  }
  return { w, cur: new Map<string, Totals>(byKey(rows, w).map((k) => [k.key, k])), before: byKey(rows, windowEnding(w.prevTo, days)) as (Totals & { key: string })[] };
}

/**
 * Pages whose clicks in the `days` days ending on `last` fell more than `minDrop` against the `days` before, from at
 * least `minPrevClicks` clicks. Most clicks lost first.
 */
export function decayingPages(
  rows: GscRow[],
  last: string,
  opts: { days?: number; minPrevClicks?: number; minDrop?: number; totals?: GscTotals | null } = {},
): DecayRow[] {
  const days = opts.days ?? DECAY.days;
  const minPrev = opts.minPrevClicks ?? DECAY.minPrevClicks;
  const minDrop = opts.minDrop ?? DECAY.minDrop;
  // The full page totals, when there is a part for these 28 days: every page, not only the top 80 of each day.
  const totals = opts.totals && days === DECAY.days ? opts.totals : null;
  if (totals) last = totals.to;
  const buckets = Math.ceil((2 * days) / 7);
  const firstBucketDay = addDays(last, -(buckets * 7 - 1));
  const weekly = new Map<string, number[]>();
  for (const r of rows) {
    if (r[0] < firstBucketDay || r[0] > last) continue;
    const i = Math.floor((Date.parse(r[0] + 'T00:00:00Z') - Date.parse(firstBucketDay + 'T00:00:00Z')) / (7 * DAY));
    const key = totals ? pagePath(r[1]) : r[1];
    let list = weekly.get(key);
    if (!list) weekly.set(key, (list = new Array(buckets).fill(0)));
    list[i] += r[2];
  }
  const { cur, before } = decayBase(rows, last, days, totals);
  const none: Totals = { clicks: 0, impressions: 0, ctr: null, position: null, days: 0 };
  const out: DecayRow[] = [];
  for (const p of before) {
    if (p.clicks < minPrev) continue;
    const c = cur.get(p.key);
    const now: Totals = c ? { clicks: c.clicks, impressions: c.impressions, ctr: c.ctr, position: c.position, days: c.days } : none;
    const prev: Totals = { clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position, days: p.days };
    const change = (now.clicks - prev.clicks) / prev.clicks;
    if (change >= -minDrop) continue;
    out.push({ key: p.key, cur: now, prev, clicksLost: prev.clicks - now.clicks, change, weekly: weekly.get(p.key) ?? new Array(buckets).fill(0) });
  }
  return out.sort((a, b) => b.clicksLost - a.clicksLost || a.key.localeCompare(b.key));
}

// ---------- queries per page (the gsc_page_queries part)

/** Days in each of the two windows the gsc_page_queries part covers, as the decay and the page detail tiles. */
export const PAGE_QUERY_DAYS = 28;
/** Page and query pairs the part keeps at most, the most clicked over both windows first (docs/SEO.md). */
export const PAGE_QUERY_ROWS = 5000;

/** [page, query, clicks, impressions, position, previous clicks, previous impressions, previous position] */
export type GscPageQuery = [string, string, number, number, number | null, number, number, number | null];

/**
 * The gsc_page_queries part: Search Console's page and query pairs summed over `from` to `to` and over the same number
 * of days before. Unlike gsc_queries and gsc_pages it has no day column, so it holds those two windows only.
 */
export interface GscPageQueries {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  rows: GscPageQuery[];
}

export interface PageQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  /** Impression-weighted average position; null without impressions in the window. */
  position: number | null;
  prev: { clicks: number; impressions: number; position: number | null };
  /** Places moved up against the window before (a smaller position is better); null when either side has no position. */
  positionChange: number | null;
}

/** True for a part that has the shape above, so a malformed push shows as "no rows" instead of breaking the page. */
export function isPageQueries(part: unknown): part is GscPageQueries {
  const p = part as GscPageQueries | null;
  return !!p && typeof p === 'object' && Array.isArray(p.rows) && typeof p.from === 'string' && typeof p.to === 'string';
}

/**
 * The queries that showed one page, from gsc_page_queries rows. Page keys that share a path (a URL and the same URL
 * with `?utm=`) add up, with positions weighted by impressions. Most clicks first, then impressions.
 */
export function queriesForPage(rows: GscPageQuery[], path: string): PageQueryRow[] {
  const by = new Map<string, { c: number[]; w: number[] }>();
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || pagePath(r[0]) !== path) continue;
    const q = String(r[1]);
    const e = by.get(q) ?? { c: [0, 0, 0, 0], w: [0, 0] };
    const [, , clicks, imps, pos, pClicks, pImps, pPos] = r;
    e.c[0] += Number(clicks) || 0;
    e.c[1] += Number(imps) || 0;
    e.c[2] += Number(pClicks) || 0;
    e.c[3] += Number(pImps) || 0;
    if (pos !== null && pos !== undefined && imps > 0) e.w[0] += pos * imps;
    if (pPos !== null && pPos !== undefined && pImps > 0) e.w[1] += pPos * pImps;
    by.set(q, e);
  }
  return [...by.entries()]
    .map(([query, { c, w }]) => {
      const position = c[1] ? w[0] / c[1] : null;
      const prevPosition = c[3] ? w[1] / c[3] : null;
      return {
        query,
        clicks: c[0],
        impressions: c[1],
        position,
        prev: { clicks: c[2], impressions: c[3], position: prevPosition },
        positionChange: position !== null && prevPosition !== null ? prevPosition - position : null,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || b.prev.clicks - a.prev.clicks || a.query.localeCompare(b.query));
}

/** Queries with impressions in the part's last window, per page path: the Content list's query count. */
export function queryCountByPage(rows: GscPageQuery[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || !(r[3] > 0)) continue;
    const path = pagePath(r[0]);
    let s = seen.get(path);
    if (!s) seen.set(path, (s = new Set()));
    s.add(String(r[1]));
  }
  return new Map([...seen].map(([p, s]) => [p, s.size]));
}

// ---------- cannibalization: two pages sharing one query (the gsc_page_queries part)

/** A page counts for a query when it has at least this share of the query's impressions and at least `minImpressions` of them. */
export const CANNIBAL = { minShare: 0.1, minImpressions: 20 };

export interface CannibalPage {
  path: string;
  clicks: number;
  impressions: number;
  position: number | null;
  /** This page's part of the query's impressions across every page, 0 to 1. */
  impressionShare: number;
  /** This page's part of the query's clicks; null when the query had no clicks. */
  clickShare: number | null;
}

export interface CannibalQuery {
  query: string;
  impressions: number;
  clicks: number;
  /** Pages that pass the bar, most impressions first. At least two. */
  pages: CannibalPage[];
}

/**
 * Queries where two or more pages each pass the bar, from the last window of gsc_page_queries rows. Page keys with the
 * same path add up. Shares are of the query's impressions and clicks across all its pages, also those below the bar.
 * Most impressions first, then the query.
 */
export function cannibalization(rows: GscPageQuery[], opts: { minShare?: number; minImpressions?: number } = {}): CannibalQuery[] {
  const minShare = opts.minShare ?? CANNIBAL.minShare;
  const minImpressions = opts.minImpressions ?? CANNIBAL.minImpressions;
  const byQuery = new Map<string, Map<string, { clicks: number; impressions: number; weighted: number }>>();
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') continue;
    const impressions = Number(r[3]) || 0;
    if (impressions <= 0) continue;
    const path = pagePath(r[0]);
    let pages = byQuery.get(r[1]);
    if (!pages) byQuery.set(r[1], (pages = new Map()));
    const e = pages.get(path) ?? { clicks: 0, impressions: 0, weighted: 0 };
    e.clicks += Number(r[2]) || 0;
    e.impressions += impressions;
    if (r[4] !== null && r[4] !== undefined) e.weighted += r[4] * impressions;
    pages.set(path, e);
  }
  const out: CannibalQuery[] = [];
  for (const [query, pages] of byQuery) {
    if (pages.size < 2) continue;
    let clicks = 0;
    let impressions = 0;
    for (const p of pages.values()) {
      clicks += p.clicks;
      impressions += p.impressions;
    }
    const list = [...pages.entries()]
      .filter(([, p]) => p.impressions >= minImpressions && p.impressions / impressions >= minShare)
      .map(([path, p]) => ({
        path,
        clicks: p.clicks,
        impressions: p.impressions,
        position: p.weighted / p.impressions,
        impressionShare: p.impressions / impressions,
        clickShare: clicks ? p.clicks / clicks : null,
      }))
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.path.localeCompare(b.path));
    if (list.length >= 2) out.push({ query, impressions, clicks, pages: list });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
}

// ---------- full totals per page or query (the gsc_page_totals and gsc_query_totals parts)

/** Days of the recent window inside the current one: an opportunity with no impressions in it drops out. */
export const RECENT_DAYS = 7;

/**
 * [key, clicks, impressions, position, previous clicks, previous impressions, previous position, recent clicks,
 * recent impressions]. The key is a query, or a page as a path. The recent numbers cover `recentFrom` to `to`.
 */
export type GscTotalRow = [string, number, number, number | null, number, number, number | null, number, number];

/**
 * The gsc_page_totals and gsc_query_totals parts: every page (or query) Search Console reports for the 28 days ending
 * on `to`, the 28 before, and the last RECENT_DAYS, without the daily parts' cut to the top 80 a day. `complete`
 * false means a window passed the pull's row cap, so the least clicked keys of that window are missing.
 */
export interface GscTotals {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  recentFrom: string;
  complete?: boolean;
  /** False when the recent pull passed the row cap, so a key with recent 0 may still have impressions. */
  recentComplete?: boolean;
  rows: GscTotalRow[];
}

export function isTotals(part: unknown): part is GscTotals {
  const p = part as GscTotals | null;
  return !!p && typeof p === 'object' && Array.isArray(p.rows) && typeof p.from === 'string' && typeof p.to === 'string' && typeof p.previousFrom === 'string';
}

export interface TotalKeyRow extends KeyRow {
  /** Clicks and impressions in the last RECENT_DAYS of the window. */
  recent: { clicks: number; impressions: number };
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY) + 1;

/** A totals part as KeyRows (the window's sums, the window before as `prev`), keys with the same name added up. Most clicks first. */
export function totalsByKey(part: GscTotals, keyOf: (k: string) => string = (k) => k): TotalKeyRow[] {
  const by = new Map<string, { s: number[]; w: [number, number] }>();
  for (const r of part.rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
    const key = keyOf(r[0]);
    const e = by.get(key) ?? { s: [0, 0, 0, 0, 0, 0], w: [0, 0] };
    const n = (v: unknown) => Number(v) || 0;
    e.s[0] += n(r[1]);
    e.s[1] += n(r[2]);
    e.s[2] += n(r[4]);
    e.s[3] += n(r[5]);
    e.s[4] += n(r[7]);
    e.s[5] += n(r[8]);
    if (r[3] !== null && r[3] !== undefined) e.w[0] += n(r[3]) * n(r[2]);
    if (r[6] !== null && r[6] !== undefined) e.w[1] += n(r[6]) * n(r[5]);
    by.set(key, e);
  }
  const days = daysBetween(part.from, part.to);
  const prevDays = daysBetween(part.previousFrom, part.previousTo);
  const totals = (clicks: number, impressions: number, weighted: number, d: number): Totals => ({
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : null,
    position: impressions ? weighted / impressions : null,
    days: d,
  });
  return [...by.entries()]
    .map(([key, { s, w }]) => ({
      key,
      ...totals(s[0], s[1], w[0], days),
      prev: s[2] || s[3] ? totals(s[2], s[3], w[1], prevDays) : null,
      recent: { clicks: s[4], impressions: s[5] },
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key));
}

/**
 * The window a totals part stands for, when it is the 28 days ending on `through` (or on a day at most `slack` days
 * before it: the parts are rebuilt once a day after the daily ones). Null when the part is for another window.
 */
export function totalsFor(part: unknown, through: string, slack = 2): GscTotals | null {
  if (!isTotals(part) || daysBetween(part.from, part.to) !== DECAY.days) return null;
  return part.to <= through && part.to >= addDays(through, -slack) ? part : null;
}

// ---------- a drop of the whole site's search traffic (the gsc_daily part)

/**
 * When a drop of the whole site's Google traffic counts (searchDrop): the daily level after the drop is at least
 * `minDrop` under the level before, the level before had at least `minImpressions` impressions (or `minClicks` clicks)
 * a day over at least `minBaseDays`, the drop is `minAfterDays` to `maxAgeDays` days old on the last Search Console
 * day, and the last `recentDays` are still that low. A collapse that never recovers stays reported for 8 weeks. The `edgeDays` before the drop were still high and its first day
 * already low, so the drop starts where the level changed. A drop younger than 7 days needs `minDropEarly`, so a
 * weekend does not count.
 */
export const SEARCH_DROP = {
  minDrop: 0.5,
  minDropEarly: 0.6,
  minImpressions: 20,
  minClicks: 3,
  minAfterDays: 4,
  maxAgeDays: 56,
  baseDays: 28,
  minBaseDays: 14,
  recentDays: 3,
  edgeDays: 3,
} as const;

export interface SearchDrop {
  /** The series that fell: impressions, or clicks when impressions did not pass the bar. */
  metric: 'impressions' | 'clicks';
  /** The first day at the lower level. */
  since: string;
  /** The last Search Console day read. */
  through: string;
  /** Days from `since` to `through`, both included. */
  days: number;
  /** The days the level before is averaged over: up to 28 before `since`. */
  before_from: string;
  before_to: string;
  /** -0.95 is 95% lower, for `metric`. */
  change: number;
  clicks_before_per_day: number;
  clicks_after_per_day: number;
  impressions_before_per_day: number;
  impressions_after_per_day: number;
  /** Impression-weighted average position before and after; null without impressions. */
  position_before: number | null;
  position_after: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A drop of the whole site's Google clicks or impressions, from gsc_daily rows: the one change point in the last 98
 * days that best splits the series into a higher level and a lower one (least squares), kept when it passes
 * SEARCH_DROP. An older change point wins over a newer one when it splits better, and then nothing is reported: the
 * lower level is the site's normal by now. A day without a row inside the stored range counts as 0. Null when nothing
 * dropped.
 */
export function searchDrop(daily: readonly (readonly [string, number, number, number | null])[], opts: Partial<Record<keyof typeof SEARCH_DROP, number>> = {}): SearchDrop | null {
  const o = { ...SEARCH_DROP, ...opts };
  const by = new Map<string, [number, number, number]>();
  let first: string | null = null;
  let last: string | null = null;
  for (const r of daily) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r[0])) continue;
    const e = by.get(r[0]) ?? [0, 0, 0];
    const imps = Number(r[2]) || 0;
    e[0] += Number(r[1]) || 0;
    e[1] += imps;
    if (r[3] !== null && r[3] !== undefined) e[2] += (Number(r[3]) || 0) * imps;
    by.set(r[0], e);
    if (first === null || r[0] < first) first = r[0];
    if (last === null || r[0] > last) last = r[0];
  }
  if (!first || !last) return null;
  const windowStart = addDays(last, -(o.baseDays + o.maxAgeDays + o.minBaseDays - 1));
  const start = first > windowStart ? first : windowStart;
  const days: string[] = [];
  for (let d = start; d <= last; d = addDays(d, 1)) days.push(d);
  const n = days.length;
  const at = (i: number) => by.get(days[i]) ?? [0, 0, 0];
  const mean = (x: number[], a: number, b: number) => (b > a ? (x.slice(a, b).reduce((t, v) => t + v, 0) / (b - a)) : 0);
  const sse = (x: number[], a: number, b: number) => {
    const m = mean(x, a, b);
    let t = 0;
    for (let i = a; i < b; i++) t += (x[i] - m) ** 2;
    return t;
  };
  for (const metric of ['impressions', 'clicks'] as const) {
    const x = days.map((_, i) => at(i)[metric === 'impressions' ? 1 : 0]);
    const floor = metric === 'impressions' ? o.minImpressions : o.minClicks;
    // k is the first day at the lower level.
    let best: { k: number; cost: number } | null = null;
    for (let k = o.minBaseDays; k <= n - o.minAfterDays; k++) {
      if (mean(x, k, n) >= mean(x, 0, k)) continue;
      const cost = sse(x, 0, k) + sse(x, k, n);
      if (!best || cost < best.cost) best = { k, cost };
    }
    if (!best || n - best.k > o.maxAgeDays) continue;
    const k = best.k;
    const b0 = Math.max(0, k - o.baseDays);
    const base = mean(x, b0, k);
    const after = mean(x, k, n);
    const recent = mean(x, Math.max(k, n - o.recentDays), n);
    const change = base > 0 ? after / base - 1 : 0;
    const need = n - k < 7 ? o.minDropEarly : o.minDrop;
    const edge = mean(x, Math.max(0, k - o.edgeDays), k);
    if (base < floor || change > -need || recent > base * (1 - need)) continue;
    if (edge < base * (1 - need / 2) || x[k] > base * (1 - need / 2)) continue;
    const side = (a: number, b: number) => {
      let clicks = 0;
      let imps = 0;
      let weighted = 0;
      for (let i = a; i < b; i++) {
        const v = at(i);
        clicks += v[0];
        imps += v[1];
        weighted += v[2];
      }
      return { clicks: round1(clicks / (b - a)), imps: round1(imps / (b - a)), position: imps ? round1(weighted / imps) : null };
    };
    const pre = side(b0, k);
    const post = side(k, n);
    return {
      metric,
      since: days[k],
      through: last,
      days: n - k,
      before_from: days[b0],
      before_to: days[k - 1],
      change: Math.round(change * 1000) / 1000,
      clicks_before_per_day: pre.clicks,
      clicks_after_per_day: post.clicks,
      impressions_before_per_day: pre.imps,
      impressions_after_per_day: post.imps,
      position_before: pre.position,
      position_after: post.position,
    };
  }
  return null;
}

/** A drop whose last Search Console day is more than this many days before today is not shown: the sync stopped. */
export const SEARCH_DROP_STALE_DAYS = 14;

/**
 * searchDrop, or null when the data's last day is more than SEARCH_DROP_STALE_DAYS before `now` (ms): an old drop of a
 * site whose sync stopped is not news. Home, the portfolio, get_seo and the SEO tab all read the drop through this.
 */
export function freshSearchDrop(daily: readonly (readonly [string, number, number, number | null])[], now: number): SearchDrop | null {
  const d = searchDrop(daily);
  const oldest = new Date(now - SEARCH_DROP_STALE_DAYS * DAY).toISOString().slice(0, 10);
  return d && d.through >= oldest ? d : null;
}

/**
 * The gsc_daily rows in the end of a stored part, read without parsing the whole part: `tail` is its last bytes
 * (SQL substr), so its first row can be cut and is skipped. Rows are `["YYYY-MM-DD", clicks, impressions, position]`.
 * The part must run oldest day first (docs/SEO.md). A tail that does not is ignored: no rows, rather than old days read
 * as the newest.
 */
export function dailyTail(tail: string): GscDay[] {
  const out: GscDay[] = [];
  const re = /\[\s*"(\d{4}-\d{2}-\d{2})"\s*,\s*(-?[\d.eE+]+)\s*,\s*(-?[\d.eE+]+)\s*,\s*(null|-?[\d.eE+]+)\s*\]/g;
  for (const m of tail.matchAll(re)) {
    if (out.length && m[1] < out[out.length - 1][0]) return [];
    out.push([m[1], Number(m[2]) || 0, Number(m[3]) || 0, m[4] === 'null' ? null : Number(m[4])]);
  }
  return out;
}
