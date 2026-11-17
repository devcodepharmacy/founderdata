// Home's Growth row (GET /api/home/growth, pro/worker/growth.ts) and the paid numbers of get_portfolio
// (pro/worker/paid-stats.ts withSpend): the shape the Worker sends and the arithmetic both sides share, so the
// dashboard's MER and CAC are the ones an agent reads from get_portfolio.

/** Revenue after Apple's cut: the App Store part counts at the share the site keeps, the rest as paid. */
export const netRevenue = (gross: number, appStore: number, appleShare: number) => gross - appStore * (1 - appleShare);

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);

/**
 * MER (revenue over ad spend, net of Apple's cut, gross beside it) and blended CAC (ad spend over new customers), in
 * minor units of one currency. null where there is no spend, or no customer for CAC.
 */
export function blended(o: { revenue: number; appStore: number; appleShare: number; customers: number; spend: number }) {
  return {
    mer: ratio(netRevenue(o.revenue, o.appStore, o.appleShare), o.spend),
    mer_gross: ratio(o.revenue, o.spend),
    cac: o.spend > 0 && o.customers > 0 ? Math.round(o.spend / o.customers) : null,
  };
}

/** One site's ad spend in the period and the one before, in minor units of the site currency. */
export interface GrowthSpend {
  spend: number;
  spend_previous: number;
  /** Channel slug (meta, apple_search_ads, google_ads, ...) to spend in the period; channels without spend are left out. */
  by_channel: Record<string, number>;
  /** The share of App Store revenue the site keeps, 0 to 1: Apple's report over the last 365 days, else the commission setting. */
  apple_share: number;
}

/** Google Search Console totals over the days Search Console has: the period's length, ending on its last day. */
export interface GrowthSearch {
  /** The window, as YYYY-MM-DD in Pacific time (Search Console's days). `to` is the last day Search Console has. */
  from: string;
  to: string;
  days: number;
  clicks: number;
  impressions: number;
  /** Average position weighted by impressions; null without impressions. */
  position: number | null;
  /** The same number of days right before; null when the stored days do not reach back that far. */
  previous: { from: string; to: string; clicks: number; impressions: number; position: number | null } | null;
  /** The last day is more than 7 days old: the sync or the push stopped. */
  stale: boolean;
}

/**
 * AI answer checks of the runner (the AI visibility tab's numbers) over the period's length in UTC days, up to today.
 * The Worker counts them once an hour, at minute 55, so today's checks can be up to an hour behind the tab.
 */
export interface GrowthAi {
  from: string;
  to: string;
  days: number;
  checks: number;
  mentioned: number;
  cited: number;
  /** mentioned / checks and cited / checks, 0 to 1; null without checks. */
  mention_rate: number | null;
  citation_rate: number | null;
  previous: { checks: number; mentioned: number; cited: number; mention_rate: number | null; citation_rate: number | null } | null;
  /** When the hourly count ran, ISO 8601. */
  counted_at: string;
}

export interface GrowthSite {
  id: string;
  /** null: no ad spend in either period. */
  spend: GrowthSpend | null;
  /** null: no Search Console data stored for the site. */
  search: GrowthSearch | null;
  /** null: no AI answer check in either window. */
  ai: GrowthAi | null;
}

export interface GrowthData {
  period: string;
  tz: string;
  from: string;
  to: string;
  previous_from: string;
  previous_to: string;
  sites: GrowthSite[];
  /** More spend rows in other currencies than one request converts: some spend is left out. */
  spend_truncated?: boolean;
  /** When the hourly AI count last ran, ISO 8601; null before the first one, so no site has AI numbers yet. */
  ai_counted_at: string | null;
}

export const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);
