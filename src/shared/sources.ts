// Shared by the worker (to classify traffic) and the dashboard (to show icons).

export type Channel =
  | 'Direct'
  | 'Organic Search'
  | 'Organic Social'
  | 'AI'
  | 'Referral'
  | 'Email'
  | 'Paid';

interface KnownSource {
  name: string;
  domain: string; // used for the favicon
  channel: Channel;
  match: RegExp; // tested against referrer hostname, utm_source and ref
}

export const KNOWN_SOURCES: KnownSource[] = [
  { name: 'X', domain: 'x.com', channel: 'Organic Social', match: /^(t\.co|(.*\.)?(x|twitter)\.com|com\.twitter\.android|x|twitter|tw)$/ },
  { name: 'Google', domain: 'google.com', channel: 'Organic Search', match: /^((www\.)?google\.[a-z.]+|google)$/ },
  { name: 'Bing', domain: 'bing.com', channel: 'Organic Search', match: /^((.*\.)?bing\.com|bing)$/ },
  { name: 'DuckDuckGo', domain: 'duckduckgo.com', channel: 'Organic Search', match: /^((.*\.)?duckduckgo\.com|duckduckgo|ddg)$/ },
  { name: 'Yahoo', domain: 'yahoo.com', channel: 'Organic Search', match: /^((.*\.)?yahoo\.[a-z.]+|yahoo)$/ },
  { name: 'Yandex', domain: 'yandex.com', channel: 'Organic Search', match: /^((.*\.)?yandex\.[a-z.]+|yandex)$/ },
  { name: 'Baidu', domain: 'baidu.com', channel: 'Organic Search', match: /^((.*\.)?baidu\.com|baidu)$/ },
  { name: 'Ecosia', domain: 'ecosia.org', channel: 'Organic Search', match: /^((.*\.)?ecosia\.org|ecosia)$/ },
  { name: 'Brave Search', domain: 'search.brave.com', channel: 'Organic Search', match: /^(search\.brave\.com)$/ },
  { name: 'ChatGPT', domain: 'chatgpt.com', channel: 'AI', match: /^((.*\.)?(chatgpt\.com|openai\.com)|chatgpt|chatgpt\.com|openai)$/ },
  { name: 'Claude', domain: 'claude.ai', channel: 'AI', match: /^((.*\.)?claude\.ai|claude)$/ },
  { name: 'Perplexity', domain: 'perplexity.ai', channel: 'AI', match: /^((.*\.)?perplexity\.ai|perplexity)$/ },
  { name: 'Gemini', domain: 'gemini.google.com', channel: 'AI', match: /^(gemini\.google\.com|gemini|bard\.google\.com)$/ },
  { name: 'Copilot', domain: 'copilot.microsoft.com', channel: 'AI', match: /^(copilot\.microsoft\.com|copilot)$/ },
  { name: 'DeepSeek', domain: 'deepseek.com', channel: 'AI', match: /^((.*\.)?deepseek\.com|deepseek)$/ },
  { name: 'Grok', domain: 'grok.com', channel: 'AI', match: /^((.*\.)?grok\.com|grok)$/ },
  { name: 'YouTube', domain: 'youtube.com', channel: 'Organic Social', match: /^((.*\.)?(youtube\.com|youtu\.be)|youtube|yt)$/ },
  { name: 'LinkedIn', domain: 'linkedin.com', channel: 'Organic Social', match: /^((.*\.)?(linkedin\.com|lnkd\.in)|linkedin)$/ },
  { name: 'Reddit', domain: 'reddit.com', channel: 'Organic Social', match: /^((.*\.)?reddit\.com|reddit)$/ },
  // fb, ig, msg and an are the values of Meta's {{site_source_name}} URL parameter (docs/GUIDE.md, "Meta ads").
  { name: 'Facebook', domain: 'facebook.com', channel: 'Organic Social', match: /^((.*\.)?(facebook\.com|fb\.com|fb\.me)|facebook|fb)$/ },
  { name: 'Instagram', domain: 'instagram.com', channel: 'Organic Social', match: /^((.*\.)?instagram\.com|instagram|ig)$/ },
  { name: 'Messenger', domain: 'messenger.com', channel: 'Organic Social', match: /^((.*\.)?messenger\.com|messenger|msg)$/ },
  { name: 'Audience Network', domain: 'facebook.com', channel: 'Referral', match: /^(an|audience[_-]?network)$/ },
  { name: 'Meta', domain: 'meta.com', channel: 'Organic Social', match: /^(meta|meta[_-]?ads)$/ },
  { name: 'Threads', domain: 'threads.net', channel: 'Organic Social', match: /^((.*\.)?threads\.(net|com)|threads)$/ },
  { name: 'TikTok', domain: 'tiktok.com', channel: 'Organic Social', match: /^((.*\.)?tiktok\.com|tiktok)$/ },
  { name: 'Pinterest', domain: 'pinterest.com', channel: 'Organic Social', match: /^((.*\.)?pinterest\.[a-z.]+|pinterest)$/ },
  { name: 'Bluesky', domain: 'bsky.app', channel: 'Organic Social', match: /^((.*\.)?bsky\.app|bluesky|bsky)$/ },
  { name: 'Mastodon', domain: 'mastodon.social', channel: 'Organic Social', match: /^((.*\.)?mastodon\.[a-z.]+|mastodon)$/ },
  { name: 'Hacker News', domain: 'news.ycombinator.com', channel: 'Organic Social', match: /^(news\.ycombinator\.com|hackernews|hn)$/ },
  { name: 'Product Hunt', domain: 'producthunt.com', channel: 'Referral', match: /^((.*\.)?producthunt\.com|producthunt|ph)$/ },
  { name: 'Medium', domain: 'medium.com', channel: 'Referral', match: /^((.*\.)?medium\.com|medium)$/ },
  { name: 'Substack', domain: 'substack.com', channel: 'Referral', match: /^((.*\.)?substack\.com|substack)$/ },
  { name: 'Dev.to', domain: 'dev.to', channel: 'Referral', match: /^(dev\.to|devto)$/ },
  { name: 'Indie Hackers', domain: 'indiehackers.com', channel: 'Referral', match: /^((.*\.)?indiehackers\.com|indiehackers)$/ },
  { name: 'GitHub', domain: 'github.com', channel: 'Referral', match: /^((.*\.)?github\.com|github)$/ },
  { name: 'Gmail', domain: 'mail.google.com', channel: 'Email', match: /^(mail\.google\.com|gmail)$/ },
  { name: 'Outlook', domain: 'outlook.com', channel: 'Email', match: /^((.*\.)?(outlook\.(com|live\.com)|outlook\.office\.com))$/ },
  { name: 'Newsletter', domain: '', channel: 'Email', match: /^(newsletter|email|mail)$/ },
];

/**
 * Ad platforms that add a click id to the landing URL. `params` are the query parameter names, lowercase; `source` is
 * the source a click from that network gets. A click id always means a paid click, so the channel is Paid. Meta's fbclid
 * stays apart (src/worker/collect.ts metaClick): Meta adds it to organic link clicks too. The Swift SDK keeps the same
 * table (ios/Sources/FounderDataKit/Attribution.swift, ClickNetwork).
 */
export const CLICK_NETWORKS = [
  { network: 'google_ads', source: 'Google Ads', domain: 'ads.google.com', params: ['gclid', 'gbraid', 'wbraid'] },
  { network: 'microsoft_ads', source: 'Microsoft Ads', domain: 'ads.microsoft.com', params: ['msclkid'] },
  { network: 'tiktok_ads', source: 'TikTok Ads', domain: 'tiktok.com', params: ['ttclid'] },
  { network: 'x_ads', source: 'X Ads', domain: 'x.com', params: ['twclid'] },
  { network: 'linkedin_ads', source: 'LinkedIn Ads', domain: 'linkedin.com', params: ['li_fat_id'] },
  { network: 'reddit_ads', source: 'Reddit Ads', domain: 'reddit.com', params: ['rdt_cid'] },
  { network: 'snapchat_ads', source: 'Snapchat Ads', domain: 'snapchat.com', params: ['sccid'] },
  { network: 'pinterest_ads', source: 'Pinterest Ads', domain: 'pinterest.com', params: ['epik'] },
] as const;

export type ClickNetwork = (typeof CLICK_NETWORKS)[number]['network'];

/** Each click parameter with its network and rank: network order, then parameter order (gclid before gbraid). */
const CLICK_PARAMS = new Map<string, { network: ClickNetwork; rank: number }>(
  CLICK_NETWORKS.flatMap((n) => n.params.map((p) => [p, n.network] as const)).map(([p, network], rank) => [p, { network, rank }]),
);
/**
 * A click id: 8 to 500 printable characters without spaces or braces. TikTok's and Pinterest's ids may hold + / and =;
 * braces mean an unfilled macro ("{gclid}").
 */
const CLICK_ID = /^[\x21-\x7a|~]{8,500}$/;

export function isClickNetwork(v: unknown): v is ClickNetwork {
  return typeof v === 'string' && CLICK_NETWORKS.some((n) => n.network === v);
}

/** A click the app SDK sent as `click_network` and `click_id` (docs/APP-API.md), or null when either is not valid. */
export function appClickOf(network: unknown, id: unknown): { network: ClickNetwork; id: string } | null {
  if (!isClickNetwork(network) || typeof id !== 'string') return null;
  const v = id.trim();
  return CLICK_ID.test(v) ? { network, id: v } : null;
}

/** The source name of a click network ("Google Ads"), or undefined. */
export function clickNetworkSource(network: string | null | undefined): string | undefined {
  return CLICK_NETWORKS.find((n) => n.network === network)?.source;
}

/**
 * The ad click id the query string carries, or null. With more than one, the first in CLICK_NETWORKS order wins, then
 * the first parameter of that network (gclid before gbraid), then the first occurrence. Parameter names match in any
 * case (ScCid and sccid). A value that is not a click id (an unfilled macro, a space) does not count.
 */
export function clickIdOf(q: URLSearchParams): { network: ClickNetwork; id: string } | null {
  let found: { network: ClickNetwork; id: string; rank: number } | null = null;
  for (const [key, value] of q) {
    const param = CLICK_PARAMS.get(key.toLowerCase());
    if (!param) continue;
    // A + the link did not encode arrives as a space: put it back, so the id still matches the network's.
    const id = value.trim().replace(/ /g, '+');
    if (!CLICK_ID.test(id)) continue;
    if (!found || param.rank < found.rank) found = { network: param.network, id, rank: param.rank };
  }
  return found ? { network: found.network, id: found.id } : null;
}

const PAID_MEDIUM = /^(cpc|ppc|cpm|paid|paid[_-]?social|paidsearch|ads?|display|retargeting|sponsored)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter)$/i;
const SOCIAL_MEDIUM = /^(social|social[_-]?media|sm)$/i;

export function findKnownSource(key: string | null | undefined): KnownSource | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().trim();
  return KNOWN_SOURCES.find((s) => s.match.test(k));
}

export function domainForSource(name: string): string | undefined {
  return KNOWN_SOURCES.find((s) => s.name === name)?.domain || CLICK_NETWORKS.find((n) => n.source === name)?.domain || undefined;
}

export interface Attribution {
  source: string;
  channel: Channel;
  referrerDomain: string | null;
}

/**
 * Decide where a visit came from. An explicit `ref` / `utm_source` wins over the HTTP referrer,
 * because that's how you tag a specific tweet or article ("?ref=launch-tweet").
 */
export function classify(input: {
  referrerDomain: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  ref?: string | null;
  /** The landing URL carried a Meta ad id (`ad_id={{ad.id}}`): a paid click even without a paid utm_medium. */
  metaAd?: boolean;
  /** The landing URL carried another network's click id (clickIdOf): a paid click from that network, whatever else it says. */
  clickNetwork?: string | null;
}): Attribution {
  const { referrerDomain, utmSource, utmMedium, ref, metaAd } = input;
  // gclid on a google.com referral is a Google Ads click, not organic search. Meta's ad id wins: it names the ad.
  const clickSource = metaAd ? undefined : clickNetworkSource(input.clickNetwork);
  if (clickSource) return { source: clickSource, channel: 'Paid', referrerDomain };
  const tag = utmSource || ref || null;
  // An ad click with no utm_source still came from Meta; the referrer says which app, else it is "Meta".
  const known = findKnownSource(tag) ?? findKnownSource(referrerDomain) ?? (metaAd ? findKnownSource('meta') : undefined);

  let source: string;
  if (known) source = known.name;
  else if (tag) source = tag;
  else if (referrerDomain) source = referrerDomain;
  else source = 'Direct/None';

  let channel: Channel;
  if ((utmMedium && PAID_MEDIUM.test(utmMedium)) || metaAd) channel = 'Paid';
  else if (utmMedium && EMAIL_MEDIUM.test(utmMedium)) channel = 'Email';
  else if (known) channel = known.channel;
  else if (utmMedium && SOCIAL_MEDIUM.test(utmMedium)) channel = 'Organic Social';
  else if (tag || referrerDomain) channel = 'Referral';
  else channel = 'Direct';

  return { source, channel, referrerDomain };
}
