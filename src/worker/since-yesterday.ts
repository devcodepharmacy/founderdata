import type { Site } from './env';
import { convertMajor, PAY_AMOUNT, payCurrency, rateLookup } from './fx';
import { currencyDecimals } from './payments';
import { REAL } from './stats';
import { proHooks } from './pro-hooks';
import { netSharesAll, netSharesFrom, type ShareRow } from './commission';
import { dayInTz, midnight } from './lib/time';
import { META_VISIT } from './meta-campaigns';

/**
 * The "Since yesterday" card of the phone's Home (docs/MOBILE-API.md section 5): what came in over the last 24 hours
 * against the 24 hours before, whatever period Home shows, and Apple Search Ads spend on the last day Apple reported.
 *
 * - Revenue and new customers are payment rows, the same as the home page's "Last 24 hours" period: a rolling 24
 *   hours holds no whole day of Apple's sales report, so the report never replaces them here.
 * - Trials are subscriptions whose trial started in the window (sandbox left out), counted like the Subscriptions tab.
 * - `asa` is null until Apple's numbers hold spend for a site's app in the last ASA_DAYS days. `spend` is the latest
 *   day with spend, yesterday or before (Apple reports by UTC day, a few hours late). The 30-day numbers (spend,
 *   paid, cost per paid, revenue, ROAS) are each site's asaSummary (pro/worker/asa-stats.ts): the totals the site's
 *   overview, App tab and GET /api/v1/asa show for "30 days", the 30 days up to yesterday in the site's timezone.
 * - `meta` is null until a site with a Meta ad account (meta_settings) has spend in the META_DAYS days up to
 *   yesterday, and null unless the caller asks for it (`opts.meta`): only the phone's Home shows it. Its numbers are
 *   the totals the site's Meta ads view (pro/worker/meta-stats.ts) shows for the same days: spend, and the visits
 *   credited to Meta ads with what they paid to date (metaStatements).
 *
 * Two or three reads in one batch, plus three per app with Apple spend (asaSummary). `opts.meta` true adds two
 * statements to that batch, and a rate read when an ad account bills in another currency. No writes.
 */

const DAY = 86_400_000;
/** The days cost per paid counts, and how far back a spend row makes `asa` show. */
export const ASA_DAYS = 30;
/** The days the Meta numbers cover, up to yesterday: Meta's own default for judging an ad. */
export const META_DAYS = 7;

type Money = Record<string, number>;

export interface SinceYesterday {
  /** The last 24 hours, ms: [from, to). The 24 hours before end at `from`. */
  from: number;
  to: number;
  /** Minor units per currency, each site's payments converted to its currency as on the home page. */
  revenue: Money;
  revenuePrevious: Money;
  /** First payments that are not renewals, one per customer and site. */
  customers: number;
  customersPrevious: number;
  trials: number;
  trialsPrevious: number;
  asa: SinceYesterdayAsa | null;
  meta: SinceYesterdayMeta | null;
}

export interface SinceYesterdayMeta {
  /** The sites whose Meta ad account had spend in the META_DAYS days, in the order of `sites`. */
  sites: string[];
  /** The day `spend` is for: the latest ad account day with spend, yesterday at the latest. */
  day: string;
  /** Minor units per site currency, at the day's ECB rate when the account bills in another currency. */
  spend: Money;
  /** The META_DAYS days up to yesterday, in the account's days. */
  from: string;
  to: string;
  periodSpend: Money;
  /** First purchases credited to visits from a Meta ad that started in those days, to date. */
  customers: number;
  /** periodSpend over customers, per currency; a currency without a customer is left out. */
  cpa: Money;
  /** Revenue to date credited to those visits, renewals and refunds included, in minor units of the site currency. */
  revenue: Money;
  /** revenue over periodSpend per currency, a ratio (1.4 shows as 140%); a currency without spend is left out. */
  roas: Money;
}

export interface SinceYesterdayAsa {
  /** The day `spend` is for: the latest day with spend, yesterday at the latest. */
  day: string;
  /** Minor units per site currency, at the day's ECB rate. */
  spend: Money;
  /** The 30 days of asaSummary: up to yesterday in the site's timezone. */
  from: string;
  to: string;
  periodSpend: Money;
  /** First purchases of installs from Apple Search Ads that started in those days, to date. */
  paid: number;
  /** periodSpend over paid, per currency; a currency without a paid conversion is left out. */
  costPerPaid: Money;
  /**
   * Gross revenue to date from those installs, renewals and refunds included, sandbox left out, in minor units of the
   * site currency. ROAS is revenue over periodSpend, as on the App tab's Apple Search Ads panel with window "to date".
   */
  revenue: Money;
  /** revenue over periodSpend per currency, a ratio (0.8 shows as 80%); a currency without spend is left out. */
  roas: Money;
}

const add = (m: Money, cc: string, v: number) => {
  m[cc] = (m[cc] ?? 0) + v;
};
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The site whose app a campaign promotes: its App Store id, or the bundle id Apple's lookup found for that id. */
function campaignSite(apps: Site[], app: string | null, bundle: string | null): Site | undefined {
  return apps.find((s) => (app && (s.asc_app_id === app || s.app_store_id === app)) || (bundle && s.app_bundle_id === bundle));
}

/** Campaign spend rows: totals (keyword '') per day and currency, with the app each campaign promotes. */
type SpendRow = { app: string | null; bundle: string | null; day: string; currency: string | null; spend: number };
const SPEND_SQL = `SELECT c.parent AS app, a.parent AS bundle, d.day, d.currency, SUM(d.spend) AS spend
  FROM asa_daily d JOIN asa_names c ON c.kind = 'campaign' AND c.id = d.campaign
  LEFT JOIN asa_names a ON a.kind = 'app' AND a.id = c.parent
  WHERE d.keyword = '' AND d.day >= ? AND d.day <= ? AND d.spend > 0
  GROUP BY 1, 2, 3, 4`;

/**
 * The Apple Search Ads reads of sinceYesterday, started before the caller knows its sites or timezone (home.ts round
 * trip 1): the campaign spend over a span of days that covers ASA_DAYS in any timezone, and the App Store net shares
 * (commission.ts) of the sites a campaign with spend in the span promotes.
 */
export interface AsaPrefetch {
  from: string;
  to: string;
  spend: SpendRow[];
  shares: Map<string, ShareRow[]>;
}

export async function asaPrefetch(db: D1Database, now: number): Promise<AsaPrefetch> {
  const from = shiftDay(new Date(now).toISOString().slice(0, 10), -(ASA_DAYS + 2));
  const to = shiftDay(new Date(now).toISOString().slice(0, 10), 1);
  const [spend, shares] = await Promise.all([
    db.prepare(SPEND_SQL).bind(from, to).all<SpendRow>(),
    // Only the sites a campaign with spend in the span promotes (campaignSite, in SQL).
    netSharesAll(
      db,
      now,
      `site_id IN (SELECT st.id FROM sites st WHERE EXISTS (
         SELECT 1 FROM asa_daily d JOIN asa_names c ON c.kind = 'campaign' AND c.id = d.campaign
         LEFT JOIN asa_names a ON a.kind = 'app' AND a.id = c.parent
         WHERE d.keyword = '' AND d.spend > 0 AND d.day >= '${from}'
           AND (c.parent = st.asc_app_id OR c.parent = st.app_store_id OR a.parent = st.app_bundle_id)))`,
    ),
  ]);
  return { from, to, spend: spend.results, shares };
}

/**
 * `opts.meta`: true reads the Meta block alongside the rest; a list from metaSites (the 08:00 push, which reads it
 * once for every device group) is added up for `sites`; false or left out gives `meta: null` and reads nothing.
 */
export async function sinceYesterday(
  db: D1Database,
  sites: Site[],
  tz: string,
  now: number,
  opts: { asa?: AsaPrefetch | null; meta?: boolean | MetaSite[] } = {},
): Promise<SinceYesterday> {
  const from = now - DAY;
  const before = now - 2 * DAY;
  const ids = sites.map((s) => s.id);
  const apps = sites.filter((s) => s.app_bundle_id || s.asc_app_id || s.app_store_id);
  const yesterday = shiftDay(dayInTz(now, tz), -1);
  const asaFrom = shiftDay(yesterday, -(ASA_DAYS - 1));
  const marks = ids.map(() => '?').join(', ');

  const pre = opts.asa && opts.asa.from <= asaFrom && opts.asa.to >= yesterday ? opts.asa : null;
  // With the spend read ahead, the Search Ads summaries start now, alongside the batch below.
  const early = pre && apps.length ? asaSince(db, apps, pre.spend.filter((r) => r.day >= asaFrom && r.day <= yesterday), now, pre.shares) : null;
  early?.catch(() => undefined);
  const ws = opts.meta === true ? metaWindows(sites, now) : [];
  const res = await db.batch([
    db
      .prepare(
        `SELECT ${payCurrency('st.currency')} AS currency, (p.ts >= ?) AS cur, SUM(${PAY_AMOUNT}) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN p.site_id || ' ' || COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE p.site_id IN (${marks}) AND p.ts >= ? AND p.ts < ? AND ${REAL} GROUP BY 1, 2`,
      )
      .bind(from, ...ids, before, now),
    db
      .prepare(
        `SELECT (trial_start >= ?) AS cur, COUNT(*) AS n FROM subscriptions
         WHERE site_id IN (${marks}) AND sandbox = 0 AND trial_start >= ? AND trial_start < ? GROUP BY cur`,
      )
      .bind(from, ...ids, before, now),
    // Meta spend, and the customers and revenue of Meta visits (metaStatements), when the caller shows them.
    ...(ws.length ? metaStatements(db, ws, now) : []),
    // Campaign totals (keyword '') per day and currency, with the app each campaign promotes. Read ahead with `asa`
    // when its span covers the days.
    ...(pre ? [] : [db.prepare(SPEND_SQL).bind(asaFrom, yesterday)]),
  ]);
  const [pays, trials] = res;
  const metaRes = ws.length ? res.slice(2, 4) : null;
  const spendRows = pre ? null : res[ws.length ? 4 : 2];

  const revenue: Money = {};
  const revenuePrevious: Money = {};
  let customers = 0;
  let customersPrevious = 0;
  for (const r of pays.results as any[]) {
    if (!r.currency) continue;
    add(r.cur ? revenue : revenuePrevious, r.currency, Number(r.revenue));
    if (r.cur) customers += Number(r.customers);
    else customersPrevious += Number(r.customers);
  }
  // Meta (its rate read, if any) runs alongside the Search Ads summaries.
  const meta: Promise<SinceYesterdayMeta | null> = (
    Array.isArray(opts.meta)
      ? Promise.resolve(metaBlock(opts.meta, ids))
      : metaRes
        ? metaFrom(db, ws, metaRes[0].results as MetaSpendRow[], metaRes[1].results as MetaPayRow[], now).then((list) => metaBlock(list, ids))
        : Promise.resolve(null)
  ).catch((e) => {
    console.error('Since yesterday: Meta failed', e);
    return null;
  });
  let trialsNow = 0;
  let trialsPrevious = 0;
  for (const r of trials.results as any[]) {
    if (r.cur) trialsNow += Number(r.n);
    else trialsPrevious += Number(r.n);
  }

  return {
    from,
    to: now,
    revenue,
    revenuePrevious,
    customers,
    customersPrevious,
    trials: trialsNow,
    trialsPrevious,
    asa: early ? await early : apps.length && spendRows ? await asaSince(db, apps, spendRows.results as SpendRow[], now) : null,
    meta: await meta,
  };
}

// ---------- Meta ads

/**
 * One site's Meta numbers over the META_DAYS days up to yesterday in its timezone, from metaStatements: what the
 * site's Meta ads view (pro/worker/meta-stats.ts) shows as totals for the same days. Money in minor units of the site
 * currency, unrounded.
 */
export interface MetaSite {
  site: string;
  currency: string;
  /** The account days, both included. */
  from: string;
  to: string;
  /** Spend per account day with spend, at the day's ECB rate when the account bills in another currency. */
  spendByDay: Record<string, number>;
  spend: number;
  customers: number;
  revenue: number;
}

/** A site's Meta days, and the visits those days hold: from its midnight META_DAYS days ago to its midnight today. */
interface MetaWindow {
  site: Site;
  from: string;
  to: string;
  start: number;
  end: number;
}

function metaWindows(sites: Site[], now: number): MetaWindow[] {
  return sites.map((site) => {
    const today = dayInTz(now, site.timezone);
    const from = shiftDay(today, -META_DAYS);
    return { site, from, to: shiftDay(today, -1), start: midnight(from, site.timezone), end: midnight(today, site.timezone) };
  });
}

type MetaSpendRow = { site: string; day: string; spend: number; currency: string | null };
type MetaPayRow = { site: string; customers: number; revenue: number };

/**
 * Two statements for every site in `ws` at once, so they ride in sinceYesterday's first batch. Each only touches sites
 * with a Meta ad account (a join on meta_settings), so a deployment without Meta reads no rows.
 *
 * - Spend: the account's days, inside the campaign filter, summed per day (meta_daily_account_day).
 * - Customers and revenue: payments since the window opened, joined to the Meta visits they are credited to, counted
 *   per ad and summed, as the view's totals do. Starting from payments (payments_site_time) reads the window's payments
 *   instead of every session of 7 days. A payment comes after the visit it is credited to; the read starts a day before
 *   the window all the same, for a payment whose time was recorded a little early.
 *
 * The days and times are numbers and dates this function made, so they go in the SQL; site ids are bound.
 */
function metaStatements(db: D1Database, ws: MetaWindow[], now: number) {
  const ids = ws.map((x) => x.site.id);
  const asOf = Math.floor(now + 60_000);
  const spend = db
    .prepare(
      `WITH w(site_id, d_from, d_to) AS (VALUES ${ws.map((x) => `(?, '${x.from}', '${x.to}')`).join(', ')})
       SELECT ms.site_id AS site, d.day, SUM(d.spend) AS spend, MAX(a.currency) AS currency
       FROM w JOIN meta_settings ms ON ms.site_id = w.site_id AND ms.ad_account_id IS NOT NULL
       JOIN meta_daily d ON d.account_id = ms.ad_account_id AND d.day >= w.d_from AND d.day <= w.d_to
       LEFT JOIN meta_accounts a ON a.id = ms.ad_account_id
       WHERE d.spend > 0 AND (trim(COALESCE(ms.campaign_filter, '')) = '' OR d.campaign_id IN (
         SELECT o.id FROM meta_objects o WHERE o.kind = 'campaign' AND o.account_id = ms.ad_account_id
           AND instr(lower(o.name), lower(trim(ms.campaign_filter))) > 0))
       GROUP BY ms.site_id, d.day`,
    )
    .bind(...ids);
  const pays = db
    .prepare(
      `WITH w(site_id, s_from, s_to) AS (VALUES ${ws.map((x) => `(?, ${Math.floor(x.start)}, ${Math.floor(x.end)})`).join(', ')})
       SELECT site, SUM(customers) AS customers, SUM(revenue) AS revenue FROM (
         SELECT w.site_id AS site,
                COALESCE(SUM(CASE WHEN p.currency = st.currency THEN p.amount ELSE COALESCE(p.amount_conv, 0) END), 0) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.session_id) END) AS customers
         FROM w JOIN meta_settings ms ON ms.site_id = w.site_id AND ms.ad_account_id IS NOT NULL
         JOIN sites st ON st.id = w.site_id
         JOIN payments p ON p.site_id = w.site_id AND p.ts >= w.s_from - ${DAY} AND p.ts < ${asOf}
         JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE s.started_at >= w.s_from AND s.started_at < w.s_to AND ${META_VISIT} AND ${REAL} AND p.kind != 'income'
         GROUP BY w.site_id, s.ad_id
       ) GROUP BY site`,
    )
    .bind(...ids);
  return [spend, pays] as const;
}

/** The rows of metaStatements as one MetaSite per site with spend. One rate read when an account bills in another currency. */
async function metaFrom(db: D1Database, ws: MetaWindow[], spendRows: MetaSpendRow[], payRows: MetaPayRow[], now: number, fill?: boolean): Promise<MetaSite[]> {
  const win = new Map(ws.map((x) => [x.site.id, x]));
  const rows = spendRows.filter((r) => win.has(r.site));
  const foreign = rows.filter((r) => r.currency && r.currency !== win.get(r.site)!.site.currency);
  const rates = foreign.length
    ? await rateLookup(
        db,
        foreign.flatMap((r) => [r.currency!, win.get(r.site)!.site.currency]),
        foreign.reduce((d, r) => (r.day < d ? r.day : d), foreign[0].day),
        foreign.reduce((d, r) => (r.day > d ? r.day : d), foreign[0].day),
        fetch,
        now,
        { fill },
      ).catch(() => () => null)
    : () => null;
  const out = new Map<string, MetaSite>();
  for (const r of rows) {
    const x = win.get(r.site)!;
    const cc = x.site.currency;
    const v = convertMajor(Number(r.spend) / 1e6, r.currency ?? cc, cc, r.day, rates);
    if (v === null || v <= 0) continue;
    let m = out.get(r.site);
    if (!m) out.set(r.site, (m = { site: r.site, currency: cc, from: x.from, to: x.to, spendByDay: {}, spend: 0, customers: 0, revenue: 0 }));
    const minor = v * 10 ** currencyDecimals(cc);
    m.spendByDay[r.day] = (m.spendByDay[r.day] ?? 0) + minor;
    m.spend += minor;
  }
  for (const p of payRows) {
    const m = out.get(p.site);
    if (!m) continue;
    m.customers += Number(p.customers);
    m.revenue += Number(p.revenue);
  }
  return [...out.values()];
}

/**
 * The Meta numbers of every site with a Meta ad account and spend in its META_DAYS days: one batch, plus a rate read
 * when an account bills in another currency. The 08:00 push reads them once for all its device groups, with `fill`
 * false so a missing rate costs no call to the rate API (that day's spend is left out).
 */
export async function metaSites(db: D1Database, sites: Site[], now: number, opts: { fill?: boolean } = {}): Promise<MetaSite[]> {
  if (!sites.length) return [];
  const ws = metaWindows(sites, now);
  const [spend, pays] = await db.batch(metaStatements(db, ws, now) as unknown as D1PreparedStatement[]);
  return metaFrom(db, ws, spend.results as MetaSpendRow[], pays.results as MetaPayRow[], now, opts.fill);
}

/**
 * The Meta block of the sites in `ids`, added up per currency, in the order of `ids`. `from` and `to` are the days of
 * the first site in `sites`, so they always span META_DAYS days; a site in another timezone covers its own 7 days.
 */
export function metaBlock(list: MetaSite[], ids: string[]): SinceYesterdayMeta | null {
  const order = new Map(ids.map((id, i) => [id, i]));
  const spent = list.filter((m) => order.has(m.site) && m.spend > 0).sort((a, b) => order.get(a.site)! - order.get(b.site)!);
  if (!spent.length) return null;
  const day = spent.reduce((d, m) => Object.keys(m.spendByDay).reduce((x, k) => (k > x ? k : x), d), '');
  const spend: Money = {};
  const periodSpend: Money = {};
  const customersBy: Money = {};
  const revenue: Money = {};
  let customers = 0;
  for (const m of spent) {
    add(spend, m.currency, m.spendByDay[day] ?? 0);
    add(periodSpend, m.currency, m.spend);
    add(customersBy, m.currency, m.customers);
    add(revenue, m.currency, m.revenue);
    customers += m.customers;
  }
  const cpa: Money = {};
  const roas: Money = {};
  for (const [cc, v] of Object.entries(periodSpend)) {
    if (customersBy[cc] > 0) cpa[cc] = Math.round(v / customersBy[cc]);
    if (v > 0) roas[cc] = (revenue[cc] ?? 0) / v;
  }
  const round = (m: Money) => Object.fromEntries(Object.entries(m).map(([cc, v]) => [cc, Math.round(v)]));
  return {
    sites: spent.map((m) => m.site),
    day,
    spend: round(spend),
    from: spent[0].from,
    to: spent[0].to,
    periodSpend: round(periodSpend),
    customers,
    cpa,
    revenue: round(revenue),
    roas,
  };
}

async function asaSince(db: D1Database, apps: Site[], rows: SpendRow[], now: number, shares?: Map<string, ShareRow[]>): Promise<SinceYesterdayAsa | null> {
  // The 30-day totals are Pro's (asa-stats.ts asaSummary). Without Pro nothing imports Apple Search Ads spend.
  const asaSummary = proHooks()?.asaSummary;
  if (!asaSummary) return null;
  const mine = rows.map((r) => ({ ...r, site: campaignSite(apps, r.app, r.bundle) })).filter((r) => r.site);
  if (!mine.length) return null;
  const day = mine.reduce((d, r) => (r.day > d ? r.day : d), '');
  const sites = [...new Map(mine.map((r) => [r.site!.id, r.site!])).values()];

  // The latest day's spend, in the site currency at that day's ECB rate.
  const latest = mine.filter((r) => r.day === day);
  // The rate lookup and the 30-day summaries load together.
  const [rates, summaries] = await Promise.all([
    latest.some((r) => r.currency && r.currency !== r.site!.currency)
      ? rateLookup(db, [...latest.map((r) => r.currency ?? r.site!.currency), ...sites.map((s) => s.currency)], day, day).catch(() => () => null)
      : () => null,
    // The 30 days: each site's asaSummary, the totals of its overview and App tab for "30 days".
    Promise.all(sites.map((s) => asaSummary(db, s, now, shares ? { shares: netSharesFrom(s, shares.get(s.id) ?? []) } : {}))),
  ]);
  const spend: Money = {};
  for (const r of latest) {
    const to = r.site!.currency;
    const v = convertMajor(Number(r.spend) / 1_000_000, r.currency ?? to, to, r.day, rates);
    if (v !== null) add(spend, to, v * 10 ** currencyDecimals(to));
  }

  const periodSpend: Money = {};
  const paidBy: Money = {};
  const revenue: Money = {};
  let paid = 0;
  for (const sum of summaries) {
    const t = sum.totals;
    if (t.spend !== null) add(periodSpend, sum.currency, t.spend);
    add(paidBy, sum.currency, t.paid);
    add(revenue, sum.currency, t.revenue);
    paid += t.paid;
  }
  const round = (m: Money) => Object.fromEntries(Object.entries(m).map(([cc, v]) => [cc, Math.round(v)]));
  const costPerPaid: Money = {};
  const roas: Money = {};
  for (const [cc, v] of Object.entries(periodSpend)) {
    if (paidBy[cc] > 0) costPerPaid[cc] = Math.round(v / paidBy[cc]);
    if (v > 0) roas[cc] = (revenue[cc] ?? 0) / v;
  }
  const from = summaries.reduce((d, x) => (x.from < d ? x.from : d), summaries[0].from);
  const to = summaries.reduce((d, x) => (x.to > d ? x.to : d), summaries[0].to);
  return { day, spend: round(spend), from, to, periodSpend: round(periodSpend), paid, costPerPaid, revenue: round(revenue), roas };
}
