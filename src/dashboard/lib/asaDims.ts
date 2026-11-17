/** Which kind of Apple Search Ads id a dashboard dimension or filter holds (src/worker/adservices.ts sets them). */
export type AsaKind = 'campaign' | 'adgroup' | 'keyword';

export const ASA_DIMS: Record<string, AsaKind> = {
  campaign: 'campaign',
  utm_campaign: 'campaign',
  keyword: 'keyword',
  utm_term: 'keyword',
  utm_content: 'adgroup',
};
