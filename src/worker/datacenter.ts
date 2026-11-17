// Visits from hosting networks (docs/GUIDE.md, "Datacenter visits"). A browser with a normal user agent that runs on a
// cloud server is almost always a bot: an uptime check, a scraper, a headless browser, an AI agent. Cloudflare names the
// network of every request (request.cf.asn) on every plan, so the flag costs nothing to read and rides on the session row.
//
// The list keeps to networks that rent servers. It leaves out networks that carry people: iCloud Private Relay and
// Cloudflare WARP (Cloudflare, Akamai, Fastly), consumer VPNs, and mobile and home ISPs.

/** Autonomous system numbers of hosting networks, with the name shown in docs. */
export const DATACENTER_ASNS: ReadonlyMap<number, string> = new Map([
  [16509, 'Amazon AWS'],
  [14618, 'Amazon AWS'],
  [396982, 'Google Cloud'],
  [8075, 'Microsoft Azure'],
  [14061, 'DigitalOcean'],
  [24940, 'Hetzner'],
  [213230, 'Hetzner Cloud'],
  [16276, 'OVHcloud'],
  [63949, 'Linode (Akamai Cloud)'],
  [31898, 'Oracle Cloud'],
  [20473, 'Vultr'],
  [51167, 'Contabo'],
  [12876, 'Scaleway'],
  [45102, 'Alibaba Cloud'],
  [132203, 'Tencent Cloud'],
  [60781, 'Leaseweb'],
]);

/**
 * 1 when the request came straight from a hosting network, else 0. A request that a proxy forwarded (the tracker served
 * through your own domain, docs/GUIDE.md "Proxy the script") has the proxy's network, often AWS, so it is not flagged
 * when the first X-Forwarded-For address differs from the address Cloudflare saw. Any client can write those headers, so
 * they count only with TRUST_FORWARDED_FOR on (`trustForwarded`), the same rule as the cookieless id.
 */
export function datacenterOf(asn: unknown, header: (name: string) => string | undefined, trustForwarded = false): 0 | 1 {
  const n = typeof asn === 'number' ? asn : Number(asn);
  if (!Number.isInteger(n) || !DATACENTER_ASNS.has(n)) return 0;
  if (!trustForwarded) return 1;
  const cf = header('cf-connecting-ip')?.trim();
  const first = header('x-forwarded-for')?.split(',')[0]?.trim();
  if (first && cf && first !== cf) return 0;
  // A proxy's own geo headers mean the same.
  if (header('x-vercel-ip-country') || header('x-vercel-forwarded-for')) return 0;
  return 1;
}

/** SQL that keeps sessions `alias` a site counts: every session with show_datacenter on, else only non-datacenter ones. */
export const countedSql = (show: number | undefined, alias = 's') => (show ? '' : ` AND ${alias}.datacenter = 0`);

/**
 * The same for queries over many sites: a site that shows datacenter visits keeps them. The subquery runs once and
 * reads the sites table only.
 */
export const countedAllSql = (alias = 's') => ` AND (${alias}.datacenter = 0 OR ${alias}.site_id IN (SELECT id FROM sites WHERE show_datacenter = 1))`;
