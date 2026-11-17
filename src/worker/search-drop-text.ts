import type { SearchDrop } from '../shared/seo-insights';

const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n);

/**
 * The sentence Home and the portfolio show: "Acme: Google impressions are down 95% since Oct 19, 62 a day against
 * 1,240 before. Average position went from 11 to 45. Check redirects, canonical tags and the domain before you rewrite
 * any page."
 */
export function searchDropText(name: string, d: SearchDrop): string {
  const before = d.metric === 'impressions' ? d.impressions_before_per_day : d.clicks_before_per_day;
  const after = d.metric === 'impressions' ? d.impressions_after_per_day : d.clicks_after_per_day;
  const pct = Math.round(-d.change * 100);
  const since = DAY_FMT.format(new Date(`${d.since}T00:00:00Z`));
  const moved = d.position_before !== null && d.position_after !== null && d.position_after - d.position_before >= 2;
  return (
    `${name}: Google ${d.metric} are down ${pct}% since ${since}, ${fmt(after)} a day against ${fmt(before)} before.` +
    (moved ? ` Average position went from ${d.position_before} to ${d.position_after}.` : '') +
    ' Check redirects, canonical tags and the domain before you rewrite any page.'
  );
}
