import type { Site } from './env';
import { convertMajor, rateLookup, type RateLookup } from './fx';
import { dayInTz, midnight, type Granularity } from './lib/time';
import { currencyDecimals } from './payments';

/**
 * Revenue = payments that are not App Store sales (Stripe, Dodo, the payments API, RevenueCat outside the App
 * Store) + App Store revenue. This module owns the App Store half, for every place that shows revenue: the home
 * page, a site's overview, revenue by provider and by source, the Apps page and the mobile summary.
 *
 * App Store revenue, per site and day (a calendar day in the timezone the caller reads in):
 * - The site's app is matched in App Store Connect and the day is imported (asc_import_days ok or zero): Apple's
 *   Sales and Trends report is the source. Gross customer amounts, `units * |customer_price|` in the customer
 *   currency (refund rows have negative units), in-app purchases and paid downloads, converted into the site
 *   currency at that day's ECB rate. Apple's report days are Pacific time; a report day counts as the same calendar
 *   day here, so a purchase late in the Pacific evening can sit one day off from the payment row.
 * - Any other day (today, yesterday, import lag, the import is off, or the app is not matched): the App Store
 *   payment rows (`APPLE_PAYMENT`, sandbox never) from the SDK, App Store Server Notifications and RevenueCat.
 * App Store payment rows on a day the report covers stay out of revenue (`layer.reported`), so a sale counts once.
 *
 * Only whole days use the report. A rolling window (24h, 48h) keeps payments for the day it cuts through.
 * Attribution (sources, campaigns, journeys, customers) stays per payment; see `noSourceAmount`.
 */

/** An App Store payment row: the SDK and Apple notifications, and RevenueCat purchases made in the App Store. */
export const APPLE_PAYMENT = `(p.provider = 'app_store' OR (p.provider = 'revenuecat' AND p.id LIKE 'apple\\_%' ESCAPE '\\'))`;

const DAY = 86_400_000;
const MAX_DAYS = 800;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Amounts in minor units of the site currency. `other` holds net amounts without an ECB rate, per currency. */
export interface AppleAmounts {
  gross: number;
  refunds: number;
  /** Units sold (refunded units are not subtracted, like payments count purchases). */
  units: number;
  other: Record<string, number>;
}

export const emptyApple = (): AppleAmounts => ({ gross: 0, refunds: 0, units: 0, other: {} });
export const appleNet = (a: AppleAmounts) => a.gross + a.refunds;

export interface Window {
  from: number;
  to: number;
}

export interface AppStoreLayer {
  /** SQL condition over `payments p`: an App Store payment row on a day Apple's report covers. Leave these out. */
  reported: string;
  /** Per window: the days counted from Apple's report. */
  days: string[][];
  /** A site's App Store report amounts per day of window `w`. */
  byDay(siteId: string, w: number): Map<string, AppleAmounts>;
  /** A site's App Store report amounts over window `w`. */
  total(siteId: string, w: number): AppleAmounts;
}

type LayerSite = Pick<Site, 'id' | 'currency' | 'asc_app_id'>;

/** The calendar days in `tz` that lie wholly inside the window. */
export function wholeDays(w: Window, tz: string): string[] {
  const out: string[] = [];
  if (w.to <= w.from) return out;
  let start = midnight(dayInTz(w.from, tz), tz);
  for (let d = dayInTz(w.from, tz), i = 0; start < w.to && i < MAX_DAYS; i++) {
    const next = nextDay(d);
    const end = midnight(next, tz);
    if (start >= w.from && end <= w.to) out.push(d);
    d = next;
    start = end;
  }
  return out;
}

/** The bucket label a day falls in, matching bucketLabels in src/worker/lib/time.ts. An hourly chart puts it at 00:00. */
export function dayBucket(day: string, g: Granularity): string {
  if (g === 'hour') return `${day}T00:00`;
  if (g === 'day') return day;
  if (g === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  const toSunday = (7 - d.getUTCDay()) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + toSunday - 6)).toISOString().slice(0, 10);
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function add(into: AppleAmounts, a: AppleAmounts) {
  into.gross += a.gross;
  into.refunds += a.refunds;
  into.units += a.units;
  for (const [cc, v] of Object.entries(a.other)) into.other[cc] = (into.other[cc] ?? 0) + v;
}

type LayerRow = { site_id: string; d: string; cc: string; gross: number; refunds: number; units: number };

/**
 * Apple's report rows read ahead of time for every site with an App Store app, over [from, to] (YYYY-MM-DD, both
 * included), so a caller that does not know its timezone yet can put them in its first batch (ascPrefetch). A layer
 * whose days fall inside reads nothing more; one whose days do not reads its own, as without.
 */
export interface AscPrefetch {
  from: string;
  to: string;
  imported: Set<string>;
  rows: LayerRow[];
}

const LAYER_ROWS_SQL = (siteFilter: string) => `
  SELECT site_id, report_date AS d, customer_currency AS cc,
         SUM(CASE WHEN units > 0 THEN units * ABS(customer_price) ELSE 0 END) AS gross,
         SUM(CASE WHEN units < 0 THEN units * ABS(customer_price) ELSE 0 END) AS refunds,
         SUM(CASE WHEN units > 0 THEN units ELSE 0 END) AS units
  FROM asc_sales
  WHERE site_id IN (${siteFilter}) AND report_date >= ? AND report_date <= ?
    AND kind IN ('iap', 'download') AND customer_price != 0 AND customer_currency IS NOT NULL
  GROUP BY site_id, report_date, customer_currency`;
const IMPORTED_SQL = "SELECT report_date AS d FROM asc_import_days WHERE report_date >= ? AND report_date <= ? AND status IN ('ok', 'zero')";

/**
 * The prefetch: two statements, for every site with an App Store app (`siteIds`, or all such sites when omitted). No
 * site with one: the statements read nothing.
 */
export async function ascPrefetch(db: D1Database, from: string, to: string, siteIds?: string[]): Promise<AscPrefetch> {
  const ids = siteIds ?? [];
  const filter = siteIds
    ? `SELECT id FROM sites WHERE id IN (${ids.length ? ids.map(() => '?').join(', ') : "''"}) AND asc_app_id IS NOT NULL`
    : 'SELECT id FROM sites WHERE asc_app_id IS NOT NULL';
  const [imports, rows] = await db.batch([
    // The report days only when a site has an App Store app: without one the prefetch reads no day.
    db.prepare(`${IMPORTED_SQL} AND EXISTS (${filter})`).bind(from, to, ...ids),
    db.prepare(LAYER_ROWS_SQL(filter)).bind(...ids, from, to),
  ]);
  return { from, to, imported: new Set((imports.results as { d: string }[]).map((r) => r.d)), rows: rows.results as LayerRow[] };
}

/** The UTC days a prefetch for `period` must span, for any timezone: both periods and the weeks, plus a day each side. */
export function ascPrefetchSpan(period: string, now: number, weeks = 8): { from: string; to: string } {
  const back: Record<string, number> = { today: 3, yesterday: 4, '24h': 4, '48h': 6, '7d': 16, '30d': 62, '90d': 182, '12m': 734, thisquarter: 186, lastquarter: 280 };
  const days = Math.max(back[period] ?? 62, 7 * (weeks + 2));
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: period === 'all' ? '0000-01-01' : day(now - (days + 1) * DAY), to: day(now + 2 * DAY) };
}

/**
 * A layer in two steps: `reported`, the SQL condition, is known as soon as the report days are read, and `layer()`
 * adds the amounts, which may wait on the rate lookup. A caller can build its revenue statements from `reported`
 * while the rates load.
 */
export interface LayerPlan {
  reported: string;
  layer(): Promise<AppStoreLayer>;
}

/**
 * App Store revenue from Apple's report for `sites` over each window, days in `tz`. Two D1 statements in one batch
 * (none with `prefetch` covering the days), plus the shared rate lookup when a customer currency differs from the site's.
 */
export async function appStoreLayer(
  db: D1Database,
  sites: LayerSite[],
  tz: string,
  windows: Window[],
  opts: { fetchFn?: typeof fetch; now?: number; rates?: RateLookup; prefetch?: AscPrefetch | null } = {},
): Promise<AppStoreLayer> {
  return (await appStoreLayerPlan(db, sites, tz, windows, opts)).layer();
}

export async function appStoreLayerPlan(
  db: D1Database,
  sites: LayerSite[],
  tz: string,
  windows: Window[],
  opts: { fetchFn?: typeof fetch; now?: number; rates?: RateLookup; prefetch?: AscPrefetch | null } = {},
): Promise<LayerPlan> {
  const mapped = sites.filter((s) => s.asc_app_id);
  const candidates = windows.map((w) => (mapped.length ? wholeDays(w, tz) : []));
  const all = [...new Set(candidates.flat())].sort();
  let counted: string[][] = windows.map(() => []);
  let reported = '0';
  let list: LayerRow[] = [];
  let first = '';
  let last = '';

  if (all.length) {
    first = all[0];
    last = all[all.length - 1];
    const ids = mapped.map((s) => s.id);
    let imported: Set<string>;
    const pre = opts.prefetch;
    if (pre && pre.from <= first && pre.to >= last) {
      const idSet = new Set(ids);
      imported = pre.imported;
      list = pre.rows.filter((r) => idSet.has(r.site_id) && r.d >= first && r.d <= last);
    } else {
      const [imports, rows] = await db.batch([
        db.prepare(IMPORTED_SQL).bind(first, last),
        db.prepare(LAYER_ROWS_SQL(ids.map(() => '?').join(', '))).bind(...ids, first, last),
      ]);
      imported = new Set((imports.results as { d: string }[]).map((r) => r.d));
      list = rows.results as LayerRow[];
    }
    counted = candidates.map((days) => days.filter((d) => imported.has(d)));
    list = list.filter((r) => imported.has(r.d));

    // Runs of consecutive counted days, as [local midnight, next local midnight) ranges.
    const reportDays = [...new Set(counted.flat())].sort();
    const runs: [number, number][] = [];
    for (let i = 0; i < reportDays.length; ) {
      let j = i;
      while (j + 1 < reportDays.length && reportDays[j + 1] === nextDay(reportDays[j])) j++;
      runs.push([midnight(reportDays[i], tz), midnight(nextDay(reportDays[j]), tz)]);
      i = j + 1;
    }
    if (runs.length) {
      reported = `(${APPLE_PAYMENT} AND p.site_id IN (${ids.map(quote).join(', ')}) AND (${runs.map(([a, b]) => `(p.ts >= ${a} AND p.ts < ${b})`).join(' OR ')}))`;
    }
  }

  const layer = async (): Promise<AppStoreLayer> => {
    const perSite = new Map<string, Map<string, AppleAmounts>>();
    if (list.length) {
      const currencyOf = new Map(mapped.map((s) => [s.id, s.currency]));
      const needsRates = list.some((r) => r.cc !== currencyOf.get(r.site_id));
      const rates: RateLookup =
        opts.rates ?? (needsRates ? await rateLookup(db, [...list.map((r) => r.cc), ...currencyOf.values()], first, last, opts.fetchFn ?? fetch, opts.now) : () => null);

      for (const r of list) {
        const to = currencyOf.get(r.site_id)!;
        const days = perSite.get(r.site_id) ?? new Map<string, AppleAmounts>();
        perSite.set(r.site_id, days);
        const day = days.get(r.d) ?? emptyApple();
        days.set(r.d, day);
        day.units += Number(r.units);
        const scale = 10 ** currencyDecimals(to);
        const g = convertMajor(Number(r.gross), r.cc, to, r.d, rates);
        const f = convertMajor(Number(r.refunds), r.cc, to, r.d, rates);
        if (g === null || f === null) {
          const own = 10 ** currencyDecimals(r.cc);
          day.other[r.cc] = (day.other[r.cc] ?? 0) + Math.round((Number(r.gross) + Number(r.refunds)) * own);
        } else {
          day.gross += g * scale;
          day.refunds += f * scale;
        }
      }
      for (const days of perSite.values()) {
        for (const a of days.values()) {
          a.gross = Math.round(a.gross);
          a.refunds = Math.round(a.refunds);
        }
      }
    }
    const byDay = (siteId: string, w: number) => {
      const days = perSite.get(siteId);
      const out = new Map<string, AppleAmounts>();
      if (!days) return out;
      for (const d of counted[w] ?? []) {
        const a = days.get(d);
        if (a) out.set(d, a);
      }
      return out;
    };
    return {
      reported,
      days: counted,
      byDay,
      total(siteId, w) {
        const t = emptyApple();
        for (const a of byDay(siteId, w).values()) add(t, a);
        return t;
      },
    };
  };
  let memo: Promise<AppStoreLayer> | null = null;
  return { reported, layer: () => (memo ??= layer()) };
}

/**
 * The "App Store, no source" amount for panels that split revenue by where it came from: App Store revenue in the
 * range that no attributed payment explains, never below 0. `report` is the report's net in the range; `unreported`
 * the App Store payment rows on days the report does not cover; `attributed` the App Store payment rows credited to
 * a visit, on any day of the range. All in one currency.
 */
export const noSourceAmount = (report: number, unreported: number, attributed: number) => Math.max(0, report + unreported - attributed);

/**
 * SQL for the inputs of noSourceAmount, per site and currency, over `payments p` joined to sessions `s` (LEFT JOIN):
 * `unreported` and `attributed` sums of `amount` (an SQL expression of the payment's amount). `credited` says which
 * payments a source explains: by default those with a visit, or KEPT_CREDIT when the panel also counts the source a
 * payment kept after its visit was deleted.
 */
export const appleSplitColumns = (reported: string, amount: string, credited = 's.id IS NOT NULL') =>
  `COALESCE(SUM(CASE WHEN ${reported} THEN 0 ELSE ${amount} END), 0) AS unreported,
   COALESCE(SUM(CASE WHEN ${credited} THEN ${amount} ELSE 0 END), 0) AS attributed`;

/**
 * Payments `p` LEFT JOINed to their visit `s` that credit a source: a visit, or the channel, source and campaign the
 * payment kept after its visit was deleted (migration 0064).
 */
export const KEPT_CREDIT = '(s.id IS NOT NULL OR p.channel IS NOT NULL)';
/** The source of such a payment: its visit's, else the one it kept. */
export const KEPT_SOURCE_SQL = 'CASE WHEN s.id IS NULL THEN p.source ELSE s.source END';
/** Its channel, the same way. */
export const KEPT_CHANNEL_SQL = 'CASE WHEN s.id IS NULL THEN p.channel ELSE s.channel END';

/**
 * What a site's revenue in the period is made of, so a total says what it adds up:
 * - `net_of_refunds`: Stripe, Dodo, Paddle and the other web providers, the payments API and other revenue: what the
 *   customer paid, minus refunds, before the provider's fees.
 * - `app_store_gross`: App Store sales only: the customer price with tax, before Apple's cut, minus refunds.
 * - `mixed`: both. `appStoreRevenue` holds the App Store part.
 * - null: no revenue in the period.
 */
export type RevenueBasis = 'net_of_refunds' | 'app_store_gross' | 'mixed';

export function revenueBasis(k: { revenue: Record<string, number>; appStoreRevenue: Record<string, number> }): RevenueBasis | null {
  if (!Object.values(k.revenue).some((v) => v !== 0)) return null;
  const apple = Object.values(k.appStoreRevenue).some((v) => v !== 0);
  const rest = Object.entries(k.revenue).some(([cc, v]) => v !== (k.appStoreRevenue[cc] ?? 0));
  if (!apple) return 'net_of_refunds';
  return rest ? 'mixed' : 'app_store_gross';
}

// What Apple's report says in one currency, shared with Home (the App Store reader is pro/worker/ascsales.ts).
export interface MoneyLine {
  currency: string;
  amount: number;
}

/**
 * Proceeds added up in one currency (the site's), each day's amount at that day's ECB reference rate. Amounts in a
 * currency the ECB does not publish stay in `notConverted`, so a reader can say "plus X not converted". This is a
 * reading aid, not Apple's payout: Apple converts at its own rates once a month.
 */
export interface ConvertedProceeds {
  currency: string;
  amount: number;
  notConverted: MoneyLine[];
}
