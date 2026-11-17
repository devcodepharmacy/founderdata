// DataFast API -> FounderData daily aggregates (docs/GUIDE.md, "Import from DataFast"). Pure code: the dashboard runs it in
// the browser, so the DataFast key is never stored (it goes to DataFast, or through the Worker's forwarding route when
// the browser is blocked), and the tests run it in Node with a fake API.
//
// The endpoints and fields follow DataFast's REST docs (https://datafa.st/docs/api.md and
// https://datafa.st/docs/api/website/analytics/timeseries.md, /breakdowns.md):
//   GET /api/v1/analytics/timeseries?fields=visitors,pageviews,sessions,revenue,payments&interval=day&startAt&endAt
//       -> { status, data: [{ visitors, pageviews, sessions, revenue, payments, timestamp }], totals }
//   GET /api/v1/analytics/<referrers|pages|countries|devices|browsers|operating-systems|campaigns>?startAt&endAt&limit&offset&fields
//       -> { status, data: [{ referrer | hostname,path | country | device | ..., visitors, revenue, payments }], pagination: { limit, offset, total } }
//   GET /api/v1/analytics/metadata -> { data: { name, timezone, currency, ... } }
// Auth is `Authorization: Bearer df_...` (website key) or `dft_...` (account token, which also needs `websiteId`).
// The limit is 60 requests a minute per credential. Breakdowns take one startAt/endAt window and no interval, so a per-day
// breakdown is one call per day and dimension; weekly buckets cost a seventh of that.
import { findKnownSource } from './sources';
import { MAX_LABELS, MAX_LABEL_LENGTH, validDay, type DayLabels, type DayRow, type DayTotals } from './plausible-import';

export type Granularity = 'day' | 'week';

/** One breakdown endpoint, the kind it fills, and the row field that holds the label. */
export const DIMENSIONS = [
  { path: 'referrers', kind: 'source', label: ['referrer'] },
  { path: 'pages', kind: 'page', label: ['path'] },
  { path: 'countries', kind: 'country', label: ['country'] },
  { path: 'devices', kind: 'device', label: ['device'] },
  { path: 'browsers', kind: 'browser', label: ['browser'] },
  { path: 'operating-systems', kind: 'os', label: ['operating_system', 'os'] },
  { path: 'campaigns', kind: 'campaign', label: ['utm_campaign', 'campaign'] },
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const REQUESTS_PER_MINUTE = 60;
/** A little over 1 s between calls keeps under 60 a minute. */
export const CALL_GAP_MS = 1_050;
const DAY_MS = 86_400_000;
const TS_MAX_DAYS = 900;
const PAGE = 1000;

export const dayAdd = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);

/** The buckets of a range: a day each, or 7 days from `from` (the last one shorter). `day` is the bucket's first day, where its rows are stored. */
export function buckets(from: string, to: string, g: Granularity): { day: string; from: string; to: string }[] {
  const out: { day: string; from: string; to: string }[] = [];
  const step = g === 'day' ? 1 : 7;
  for (let d = from; d <= to; d = dayAdd(d, step)) {
    const end = dayAdd(d, step - 1);
    out.push({ day: d, from: d, to: end > to ? to : end });
  }
  return out;
}

/** The calls a run makes, before the day totals say which buckets are empty: 1 per 900 days of totals, plus buckets x 7 breakdowns. */
export function estimateCalls(from: string, to: string, g: Granularity, nonEmptyShare = 1): { calls: number; minutes: number } {
  const days = daysBetween(from, to) + 1;
  const calls = 1 + Math.ceil(days / TS_MAX_DAYS) + Math.ceil(buckets(from, to, g).length * nonEmptyShare) * DIMENSIONS.length;
  return { calls, minutes: Math.ceil((calls * CALL_GAP_MS) / 60_000) };
}

// ---------- parsing answers

const int = (v: unknown, max = 1e9) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

/** DataFast's money to minor units. `unit` says what the API's numbers are; `decimals` is the site currency's. */
export const toMinor = (v: unknown, unit: 'major' | 'minor', decimals: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(unit === 'minor' ? n : n * 10 ** decimals), 1e12);
};

export interface DayTotal {
  day: string;
  visitors: number;
  pageviews: number;
  sessions: number;
  revenue: number;
  payments: number;
}

/** The days of a timeseries answer. `timestamp` is the bucket start in the website's timezone; its date part is the day. */
export function parseTimeseries(body: any): DayTotal[] {
  const out: DayTotal[] = [];
  for (const r of Array.isArray(body?.data) ? body.data : []) {
    const day = typeof r?.timestamp === 'string' ? r.timestamp.slice(0, 10) : '';
    if (!validDay(day)) continue;
    out.push({ day, visitors: int(r.visitors), pageviews: int(r.pageviews), sessions: int(r.sessions), revenue: Number(r.revenue) || 0, payments: int(r.payments) });
  }
  return out;
}

let countryCodes: Map<string, string> | null = null;
/** "United States" to "US": the dashboard stores countries as ISO codes. A two-letter value is taken as a code already. */
export function countryCode(name: string): string {
  if (/^[A-Za-z]{2}$/.test(name)) return name.toUpperCase();
  if (!countryCodes) {
    countryCodes = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++)
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const n = names.of(code);
          if (n && n !== code) countryCodes.set(n.toLowerCase(), code);
        }
    } catch {
      // no Intl.DisplayNames: names stay as they are
    }
  }
  return countryCodes.get(name.toLowerCase()) ?? name;
}

/** The label a DataFast row stands for, in the form FounderData stores it. */
export function labelOf(dim: Dimension, row: Record<string, unknown>): string | null {
  let raw: unknown;
  for (const k of dim.label) if (typeof row[k] === 'string') raw = row[k];
  if (raw === undefined) return null;
  let s = String(raw).trim();
  if (dim.kind === 'source') {
    if (/^(direct|none|direct\s*\/\s*none|\(none\)|)$/i.test(s)) return '';
    return findKnownSource(s)?.name ?? s.replace(/^https?:\/\/(www\.)?/, '');
  }
  if (dim.kind === 'country') return countryCode(s);
  if (dim.kind === 'campaign' && (s === '' || s === '(none)')) return null;
  return s.slice(0, MAX_LABEL_LENGTH);
}

export interface DimRows {
  /** label -> [visitors, pageviews]; DataFast has no pageviews per row, so the second number is 0. */
  labels: DayLabels;
  /** label -> [revenue in minor units, payments], for the sources only. */
  revenue: DayLabels;
  total: number | null;
}

/** One page of a breakdown answer, added to `into`. Labels that map to the same value (Google, google.com) are summed. */
export function addDimRows(into: DimRows, dim: Dimension, body: any, unit: 'major' | 'minor', decimals: number) {
  for (const r of Array.isArray(body?.data) ? body.data : []) {
    const label = labelOf(dim, r ?? {});
    if (label === null) continue;
    const v = int(r.visitors);
    const cur = into.labels[label] ?? [0, 0];
    into.labels[label] = [cur[0] + v, 0];
    if (dim.kind === 'source') {
      const rev = toMinor(r.revenue, unit, decimals);
      const pay = int(r.payments);
      if (rev || pay) {
        const c = into.revenue[label] ?? [0, 0];
        into.revenue[label] = [c[0] + rev, c[1] + pay];
      }
    }
  }
  const t = Number(body?.pagination?.total);
  into.total = Number.isFinite(t) ? t : null;
}

/** The labels with the most visitors, at most MAX_LABELS, as a day-row's data. Empty when there is nothing. */
export function topLabels(l: DayLabels): DayLabels {
  const e = Object.entries(l).filter(([, v]) => v[0] > 0 || v[1] > 0);
  if (e.length > MAX_LABELS) e.sort((a, b) => b[1][0] - a[1][0]);
  return Object.fromEntries(e.slice(0, MAX_LABELS));
}

// ---------- the run

export interface ApiAnswer {
  status: number;
  /** Seconds to wait, from Retry-After, on a 429. */
  retryAfter?: number | null;
  body: any;
}
export type Get = (path: string, query: Record<string, string>) => Promise<ApiAnswer>;

export interface Plan {
  from: string;
  to: string;
  /**
   * The site's first day of its own data. The range is cut to end the day before, so a weekly bucket never reaches into
   * days FounderData measured itself and nothing is counted twice. Null or left out: the range is read as it is.
   */
  nativeFrom?: string | null;
  granularity: Granularity;
  revenue: { unit: 'major' | 'minor'; decimals: number; /** false: the website's currency differs from the site's, so no revenue is imported. */ use: boolean };
}

export interface Progress {
  calls: number;
  /** Buckets finished of those planned (day totals first, then buckets with traffic). */
  done: number;
  total: number;
  /** Seconds left at the current pace. */
  etaSeconds: number;
  message: string;
}

export class DataFastError extends Error {}

/** The last day an import may read: the plan's `to`, or the day before the site's first own day when that is earlier. */
export const lastDay = (plan: Pick<Plan, 'to' | 'nativeFrom'>) => (plan.nativeFrom && dayAdd(plan.nativeFrom, -1) < plan.to ? dayAdd(plan.nativeFrom, -1) : plan.to);

export interface RevenueChoice {
  /** How DataFast writes money: whole units, minor units, or `none` to leave revenue out. Empty: not chosen yet. */
  unit: 'major' | 'minor' | 'none' | '';
  /** The person confirmed DataFast's revenue is in the site's currency, for when DataFast does not say. */
  currencyConfirmed: boolean;
}

/**
 * Whether and how revenue is imported. Revenue needs an explicit unit and a known currency: DataFast's docs show plain
 * numbers, and an unknown unit is off by a factor of 100. `blocked` is a reason the import must not start yet;
 * `notes` are warnings that do not stop it. `metadata` is the body of `analytics/metadata`.
 */
export function planRevenue(
  metadata: any,
  site: { currency: string; timezone: string; decimals: number },
  choice: RevenueChoice,
): { revenue: Plan['revenue']; blocked: string | null; notes: string[] } {
  const d = metadata?.data?.[0] ?? metadata?.data ?? {};
  const theirs = typeof d.currency === 'string' ? d.currency.toUpperCase() : '';
  const tz = typeof d.timezone === 'string' ? d.timezone : '';
  const notes: string[] = [];
  if (tz && tz !== site.timezone) notes.push(`DataFast counts days in ${tz} and this site in ${site.timezone}, so day totals can sit one day off. Set the site's timezone to match, or accept the shift.`);
  const off = { unit: 'major' as const, decimals: site.decimals, use: false };
  if (choice.unit === 'none') return { revenue: off, blocked: null, notes };
  if (!choice.unit) return { revenue: off, blocked: 'Choose how DataFast writes revenue, or choose to leave revenue out.', notes };
  if (theirs && theirs !== site.currency.toUpperCase()) {
    notes.push(`DataFast reports revenue in ${theirs} and this site uses ${site.currency}, so the revenue is left out. Visitors are imported.`);
    return { revenue: off, blocked: null, notes };
  }
  if (!theirs && !choice.currencyConfirmed) {
    return { revenue: off, blocked: `DataFast did not say which currency its revenue is in. Confirm it is ${site.currency}, or leave revenue out.`, notes };
  }
  return { revenue: { unit: choice.unit, decimals: site.decimals, use: true }, blocked: null, notes };
}

export interface RunOptions {
  get: Get;
  /** Receives day-rows to store; resolves once they are stored. */
  send: (rows: DayRow[]) => Promise<void>;
  /** `kind|day` keys already stored by an earlier run: their units are skipped. */
  done?: Set<string>;
  onProgress?: (p: Progress) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: { aborted: boolean };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch everything the plan names and hand it to `send`: the day totals first (one call per 900 days), then, for each
 * bucket with visitors, the seven breakdowns. A bucket whose sources were stored before is skipped, which is
 * how a run resumes after a reload. Calls are spaced to stay under 60 a minute; a 429 waits for Retry-After (60 s without it).
 */
export async function runDataFastImport(plan: Plan, opts: RunOptions): Promise<Progress> {
  const sleep = opts.sleep ?? realSleep;
  const done = opts.done ?? new Set<string>();
  let calls = 0;
  let last = 0;
  const started = Date.now();
  const prog: Progress = { calls: 0, done: 0, total: 0, etaSeconds: 0, message: 'Reading day totals' };
  const emit = () => {
    const elapsed = (Date.now() - started) / 1000;
    prog.etaSeconds = prog.done > 0 && prog.total > prog.done ? Math.round((elapsed / prog.done) * (prog.total - prog.done)) : prog.total > prog.done ? Math.round(((prog.total - prog.done) * CALL_GAP_MS * DIMENSIONS.length) / 1000) : 0;
    opts.onProgress?.({ ...prog });
  };
  const call = async (path: string, query: Record<string, string>): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new DataFastError('Stopped');
      const wait = last + CALL_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      calls++;
      prog.calls = calls;
      const a = await opts.get(path, query);
      if (a.status === 429 && attempt < 5) {
        prog.message = 'DataFast asked to slow down, waiting';
        emit();
        await sleep(Math.max(1, a.retryAfter ?? 60) * 1000);
        continue;
      }
      if (a.status === 401 || a.status === 403) throw new DataFastError('DataFast refused the key. Check that it is a website key (df_) or an account token (dft_) that can read analytics.');
      if (a.status >= 400 || a.body?.status === 'error') throw new DataFastError(`DataFast answered ${a.status}: ${a.body?.error?.message ?? 'an error'}`);
      return a.body;
    }
  };

  if (plan.revenue.use && plan.revenue.unit !== 'major' && plan.revenue.unit !== 'minor') throw new DataFastError('Choose how DataFast writes revenue before importing it.');
  const end = lastDay(plan);
  // Day totals, in windows of at most 900 days.
  const days: DayTotal[] = [];
  for (let from = plan.from; from <= end; from = dayAdd(from, TS_MAX_DAYS)) {
    const to = dayAdd(from, TS_MAX_DAYS - 1) > end ? end : dayAdd(from, TS_MAX_DAYS - 1);
    days.push(...parseTimeseries(await call('analytics/timeseries', { fields: 'visitors,pageviews,sessions,revenue,payments', interval: 'day', startAt: from, endAt: to })));
  }
  const totalsRows: DayRow[] = [];
  for (const d of days) {
    if (d.day < plan.from || d.day > end) continue;
    // A day with no visitors stores nothing: the chart shows it as 0 anyway, and it saves a database row.
    if ((d.visitors || d.pageviews) && !done.has(`visitors|${d.day}`)) {
      const t: DayTotals & { n: 1 } = { v: d.visitors, p: d.pageviews, s: d.sessions, b: 0, d: 0, n: 1 };
      totalsRows.push({ kind: 'visitors', day: d.day, data: t });
    }
    const rev = plan.revenue.use ? toMinor(d.revenue, plan.revenue.unit, plan.revenue.decimals) : 0;
    if ((rev || d.payments) && plan.revenue.use && !done.has(`revenue|${d.day}`)) totalsRows.push({ kind: 'revenue', day: d.day, data: { r: rev, n: d.payments } });
  }
  for (let i = 0; i < totalsRows.length; i += 100) await opts.send(totalsRows.slice(i, i + 100));

  // Buckets with traffic.
  const visits = new Map(days.map((d) => [d.day, d.visitors]));
  const todo = buckets(plan.from, end, plan.granularity).filter((b) => {
    for (let d = b.from; d <= b.to; d = dayAdd(d, 1)) if ((visits.get(d) ?? 0) > 0) return true;
    return false;
  });
  prog.total = todo.length;
  prog.message = 'Reading breakdowns';
  emit();
  for (const b of todo) {
    const rows: DayRow[] = [];
    // A bucket's rows are stored in one batch and always include its sources, so a stored source row means it is done.
    const complete = done.has(`source|${b.day}`);
    if (!complete) {
      for (const dim of DIMENSIONS) {
        const acc: DimRows = { labels: {}, revenue: {}, total: null };
        for (let offset = 0; ; offset += PAGE) {
          const q: Record<string, string> = { startAt: b.from, endAt: b.to, limit: String(PAGE), offset: String(offset) };
          const body = await call(`analytics/${dim.path}`, q);
          addDimRows(acc, dim, body, plan.revenue.unit, plan.revenue.decimals);
          const got = Array.isArray(body?.data) ? body.data.length : 0;
          if (!got || acc.total === null || offset + got >= acc.total || offset > 20_000) break;
        }
        const labels = topLabels(acc.labels);
        if (Object.keys(labels).length) rows.push({ kind: dim.kind, day: b.day, data: labels });
        if (plan.revenue.use && Object.keys(acc.revenue).length) rows.push({ kind: 'source_revenue', day: b.day, data: acc.revenue });
      }
      for (let i = 0; i < rows.length; i += 100) await opts.send(rows.slice(i, i + 100));
    }
    prog.done++;
    emit();
  }
  prog.message = 'Done';
  emit();
  return prog;
}
