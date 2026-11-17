/**
 * Apple Search Ads attribution. The app sends AAAttribution.attributionToken() on first launch; Apple's
 * AdServices API turns it into campaign, ad group and keyword ids when the install came from an ad.
 * https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken()
 */

import { upgradeFirstTouch } from './first-touch';

export const ADSERVICES_URL = 'https://api-adservices.apple.com/api/v1/';
const RETRY_MS = 5_000;

export interface AdsAttribution {
  attribution: boolean;
  orgId?: number;
  campaignId?: number;
  adGroupId?: number;
  keywordId?: number;
  adId?: number;
  conversionType?: string;
  countryOrRegion?: string;
}

/**
 * Ask Apple about a token, retrying once: Apple answers 404 for the first seconds after the token is made.
 * Returns null when Apple has no answer (bad token, still 404, network error).
 */
export async function resolveAdsToken(
  token: string,
  fetcher: typeof fetch = fetch,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<AdsAttribution | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await wait(RETRY_MS);
    try {
      const res = await fetcher(ADSERVICES_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token });
      if (res.ok) return (await res.json()) as AdsAttribution;
      // 400 = malformed token, 500 = Apple down: retrying in 5 s won't help the first, may help the second.
      if (res.status === 400) return null;
    } catch {
      // network error: retry once
    }
  }
  return null;
}

const idText = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v) ? String(v).slice(0, 64) : null);

/**
 * Resolve the token and, when the install came from an ad, mark the session as Paid / Apple Search Ads. The visitor's
 * first touch follows when this session is the visitor's first one (first seen within a minute of its start), so
 * model=first credits the ad too: the install was stored as Direct before Apple answered. 1 row more per ad install.
 */
export async function applyAdsToken(db: D1Database, siteId: string, sessionId: string, token: string, fetcher: typeof fetch = fetch) {
  const a = await resolveAdsToken(token, fetcher);
  if (!a?.attribution) return false;
  const campaign = idText(a.campaignId);
  await db.batch([
    db
      .prepare(
        `UPDATE sessions SET channel = 'Paid', source = 'Apple Search Ads', utm_campaign = ?, utm_term = ?, utm_content = ?
         WHERE site_id = ? AND id = ?`,
      )
      .bind(campaign, idText(a.keywordId), idText(a.adGroupId), siteId, sessionId),
    upgradeFirstTouch(db, siteId, sessionId, 'Apple Search Ads', campaign),
  ]);
  return true;
}
