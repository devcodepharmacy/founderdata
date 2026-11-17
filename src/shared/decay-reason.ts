// Why a page lost Search Console clicks, in one sentence. The SEO tab's Decaying pages card (SeoSection.tsx) and the
// page_decay alert rule's payload (pro/worker/alert-rules.ts) both use it, so the alert says what the card says.

/** The two windows of a decaying page, as src/shared/seo-insights.ts DecayRow has them. */
export interface DecaySides {
  cur: { impressions: number; ctr: number | null; position: number | null };
  prev: { impressions: number; ctr: number | null; position: number | null };
}

const pos = (p: number) => p.toFixed(1);
const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

/**
 * It ranks lower (1 place or more), fewer people searched (impressions down a quarter or more), or the same searches
 * at the same position bring fewer clicks.
 */
export function decayReason({ cur, prev }: DecaySides): string {
  if (!cur.impressions) return 'No impressions in the last 28 days. Google stopped showing the page.';
  if (cur.position !== null && prev.position !== null && cur.position - prev.position >= 1) {
    return `Ranks lower, average position ${pos(prev.position)} to ${pos(cur.position)}.`;
  }
  if (prev.impressions && cur.impressions < prev.impressions * 0.75) {
    return `Fewer searches, ${Math.round((1 - cur.impressions / prev.impressions) * 100)}% fewer impressions at about the same position.`;
  }
  if (cur.ctr !== null && prev.ctr !== null && cur.ctr < prev.ctr) {
    return `Fewer clicks per search, click-through rate ${pct(prev.ctr)} to ${pct(cur.ctr)} at about the same position. Check the title and the results above it.`;
  }
  return 'Clicks fell, and no single change in position, impressions or click-through rate explains it.';
}
