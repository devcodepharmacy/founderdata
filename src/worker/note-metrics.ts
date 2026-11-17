// What core knows about a note's verdict: the metrics a note can store, their windows and waits, the target grammar, and
// the shapes a Pro judge takes and returns (src/worker/pro-hooks.ts `judgeMetric`). The judges themselves are Pro's
// (pro/worker/verdicts.ts); notes.ts needs these to validate a note, date its review and cap a due list.
import type { Site } from './env';
import { productType } from './product-type';

/** Search Console is this many days behind today (pro/worker/gsc-sync.ts). */
export const GSC_LAG_DAYS = 3;
const DAY = 86_400_000;

export type Verdict = 'better' | 'worse' | 'inconclusive';

/** The metrics a note can store: what its verdict judges. */
export const NOTE_METRICS = [
  'visits',
  'keyword_rank',
  'search_clicks',
  'google_rank',
  'ai_mention_rate',
  'ai_citation_rate',
  'cpa',
  'roas',
  'paywall_conversion',
  'trial_rate',
] as const;
export type NoteMetric = (typeof NOTE_METRICS)[number];
/** What a verdict names in `verdict_metric`: a stored metric, or the one a rule fell back to. */
export type VerdictMetric = Exclude<NoteMetric, 'visits'> | 'revenue_per_visitor' | 'conversion_rate' | 'visitors' | 'search_position';

/** Days on each side of a note, by metric: Search Console, Google rank and AI answers move slowly. */
export const SLOW_WINDOW_DAYS = 28;
export const DEFAULT_WINDOW_DAYS = 7;
const SLOW = new Set<NoteMetric>(['search_clicks', 'google_rank', 'ai_mention_rate', 'ai_citation_rate']);
export const windowFor = (m: NoteMetric | null | undefined) => (m && SLOW.has(m) ? SLOW_WINDOW_DAYS : DEFAULT_WINDOW_DAYS);

/**
 * Days a verdict waits after its window, by metric: metrics read by whole days skip the note's own day, and Search
 * Console is GSC_LAG_DAYS behind; Apple's ads report comes a day after Meta's.
 */
export const WAIT_DAYS: Partial<Record<NoteMetric, number>> = {
  search_clicks: 1 + GSC_LAG_DAYS,
  google_rank: 1,
  ai_mention_rate: 1,
  ai_citation_rate: 1,
  cpa: 2,
  roas: 2,
};
export const waitDays = (m: string | null | undefined) => (m ? (WAIT_DAYS[m as NoteMetric] ?? 0) : 0);
/** The same as SQL on the notes table: days a note waits beyond its window. */
export const WAIT_SQL = `(CASE metric ${Object.entries(WAIT_DAYS)
  .map(([m, d]) => `WHEN '${m}' THEN ${d}`)
  .join(' ')} ELSE 0 END)`;

// ---------- targets

export type Target =
  | { type: 'page'; path: string }
  | { type: 'keyword'; term: string; country: string | null }
  | { type: 'prompt'; id: string }
  | { type: 'meta'; level: 'campaign' | 'adset' | 'ad' | null; id: string | null }
  | { type: 'asa'; id: string | null }
  | { type: 'none' };

/**
 * The target grammar: `/path`, `keyword:<term>` or `keyword:<term>@<country>`, `prompt:<id>`, `meta:campaign:<id>`,
 * `meta:adset:<id>`, `meta:ad:<id>`, `meta` (the channel), `asa:campaign:<id>`, `asa` (the channel). Anything else, or
 * nothing, is `none`.
 */
export function parseTarget(target: string | null | undefined): Target {
  const t = target?.trim() ?? '';
  if (t.startsWith('/') && !t.startsWith('//')) return { type: 'page', path: t.replace(/[?#].*$/, '') || '/' };
  let m = /^keyword:\s*(.+?)(?:@([a-z]{2}))?\s*$/i.exec(t);
  if (m) {
    const term = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    if (term && !/["\\]/.test(term)) return { type: 'keyword', term, country: m[2]?.toLowerCase() ?? null };
  }
  m = /^prompt:\s*([\w.-]{1,64})$/i.exec(t);
  if (m) return { type: 'prompt', id: m[1] };
  m = /^meta(?::(campaign|adset|ad):([\w-]{1,40}))?$/i.exec(t);
  if (m) return { type: 'meta', level: (m[1]?.toLowerCase() as 'campaign' | 'adset' | 'ad' | undefined) ?? null, id: m[2] ?? null };
  m = /^asa(?::campaign:([\w-]{1,40}))?$/i.exec(t);
  if (m) return { type: 'asa', id: m[1] ?? null };
  return { type: 'none' };
}

const isApp = (site: Pick<Site, 'product_type' | 'app_bundle_id'>) => !!site.app_bundle_id || productType(site) === 'app';

/**
 * The metrics a note may judge, the default first. Empty for an outage, which marks a gap and has no verdict.
 * - keyword target: the App Store rank for kind aso, the Google rank for kind seo.
 * - seo: Search Console clicks of the page, or of the site without a page.
 * - ai, or a prompt target: the mention rate, then the citation rate.
 * - ads, or an ads target: CPA, then ROAS.
 * - pricing or release on an app, without a page: paywall conversion, then trial starts per paywall view.
 * - everything else: `visits`, the visit rule (revenue per visitor, else conversion, else visitors).
 */
export function metricsFor(kind: string | null, target: string | null, site: Pick<Site, 'product_type' | 'app_bundle_id'>): NoteMetric[] {
  if (kind === 'outage') return [];
  const t = parseTarget(target);
  const rpv: NoteMetric = 'visits';
  if (t.type === 'keyword') {
    if (kind === 'aso') return ['keyword_rank', 'google_rank', rpv];
    if (kind === 'seo') return ['google_rank', 'keyword_rank', rpv];
    return [rpv, 'keyword_rank', 'google_rank'];
  }
  if (t.type === 'prompt' || (kind === 'ai' && t.type !== 'page')) return ['ai_mention_rate', 'ai_citation_rate', rpv];
  if (t.type === 'meta' || t.type === 'asa' || (kind === 'ads' && t.type !== 'page')) return ['cpa', 'roas', rpv];
  if (kind === 'seo') return ['search_clicks', rpv];
  const app: NoteMetric[] = isApp(site) && t.type !== 'page' ? ['paywall_conversion', 'trial_rate'] : [];
  if ((kind === 'pricing' || kind === 'release') && app.length) return [...app, rpv];
  return [rpv, 'search_clicks', ...app];
}


/** A rank moves enough when it changes this many places and this share of the rank before, whichever is more. */
export const RANK_MIN_PLACES = 3;
export const RANK_MIN_SHARE = 0.1;

export interface Judgement {
  scope: 'page' | 'site' | 'keyword' | 'prompt' | 'ads' | 'app';
  verdict: Verdict;
  verdict_metric: VerdictMetric | null;
  reason: string;
  /** Whole days the windows cover; null for windows in milliseconds (the caller's). */
  days_covered: number | null;
  complete: boolean | null;
  enough_data: boolean;
  thresholds: Record<string, number>;
  change: Record<string, { absolute: number; relative: number | null }>;
  /** Spread into the answer: the metric's own block, such as `search` or `ads`. */
  detail: Record<string, unknown>;
  /** The numbers come from FounderData's own collection, so an outage note leaves a gap in them. */
  own_data: boolean;
  /** The windows the judge read, in ms, when they differ from the caller's: an outage's share is taken of these. */
  windows?: { before: { from: number; to: number }; after: { from: number; to: number } };
  /** Money in the verdict: a key without revenue gets no verdict. */
  money: boolean;
}

/** "Measuring, day 11 of 28. The window closes at 2026-11-28 20:00 UTC." */
export const measuring = (day: number, win: number, reviewAfter: string) =>
  `Measuring, day ${Math.max(0, Math.min(Math.floor(day), win))} of ${win}. The window closes at ${reviewAfter.slice(0, 16).replace('T', ' ')} UTC.`;


export interface JudgeInput {
  db: D1Database;
  site: Site;
  note: { id: string; ts: number; target: string | null; group_key?: string | null };
  metric: NoteMetric;
  win: number;
  now: number;
  reviewAfter: string;
  /** The visit windows in ms, for the paywall. */
  before: { from: number; to: number };
  after: { from: number; to: number };
  complete: boolean;
}


/**
 * D1 calls a judge makes at most, each statement and batch counted once (the cron's metered binding has no batching).
 * The cron and the weekly summary ask their budget for these before they judge a note (notes.ts impactCalls).
 * Ads reads Apple's status and a rate, then Meta's report (its settings and one batch) and Apple's (its shares and
 * one batch) for each side.
 */
export const JUDGE_CALLS: Record<Exclude<NoteMetric, 'visits' | 'keyword_rank'>, number> = {
  search_clicks: 2,
  google_rank: 1,
  ai_mention_rate: 1,
  ai_citation_rate: 1,
  cpa: 10,
  roas: 10,
  paywall_conversion: 2,
  trial_rate: 2,
};

