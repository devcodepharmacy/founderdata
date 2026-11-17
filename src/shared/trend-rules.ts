/**
 * Every threshold behind the home page's status per site (siteTrend in src/worker/home.ts) and its weekly items in
 * "Worth a look" (fallingWeeks), in one place. The Worker judges with them, `/api/home` returns them as `trendRules`,
 * and the dashboard explains the status from them, so the words never drift from the code. docs/GUIDE.md describes
 * them too.
 */
export const TREND_RULES = {
  /** Revenue that moved this share against the period before is growing or declining. */
  revenueShare: 0.1,
  /** Without revenue, visitors that moved this share are growing or declining... */
  visitorShare: 0.3,
  /** ...from at least this many visitors in the period before. Below it, a site is flat. */
  visitorBase: 50,
  /** No visit or app session for this many hours, and no revenue in the period: quiet. */
  quietHours: 24,
  /** Full weeks (Monday to Sunday, in the viewer's timezone) in each site's weekly sparkline. */
  weeks: 8,
  /** Weekly revenue, or visitors on a site without revenue, below the week before this many weeks in a row... */
  fallingWeeks: 3,
  /** ...and down by at least this share from the week the fall started, from at least 20 visitors (MIN_BASE). */
  fallingShare: 0.1,
} as const;

export type TrendRules = typeof TREND_RULES;
