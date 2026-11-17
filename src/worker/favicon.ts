import type { Context } from 'hono';
import type { AppEnv } from './env';

/**
 * Site icons for the dashboard, fetched by the Worker so the browser never sends a tracked or referring domain to a
 * third party. GET /api/favicon/:domain (login required) tries the site's own /favicon.ico, then the first
 * <link rel="icon"> in the first 64 KB of its home page. Icons are cached for 7 days and misses for 1 day with the
 * Cache API, in the Cloudflare data center. Nothing is written to D1.
 *
 * Every URL it fetches, the start and each redirect (at most 3, followed by hand), must name a public host by name:
 * no IP literal in any spelling, no localhost or private-use name, no port other than 80 and 443, no user:password.
 * A public name that resolves to a private address can't be checked from a Worker, which can't resolve DNS. On
 * Cloudflare that does no harm, as a Worker's fetch can't reach private ranges; under `wrangler dev` it can, so keep
 * a local dev server off untrusted networks.
 */

const HIT_TTL = 7 * 86_400;
const MISS_TTL = 86_400;
export const MAX_ICON_BYTES = 100_000;
const MAX_HTML_BYTES = 64 * 1024;
const TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE_RE = /^image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp|svg\+xml|avif)$/;

/** A public host name like example.com, lowercased without `www.`; null for anything else (IPs, localhost, .invalid). */
export function cleanIconDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) return null;
  if (/\.(invalid|test|example|localhost|local|internal|intranet|private|corp|home|lan|arpa|onion)$/.test(d)) return null;
  // Public names that resolve to whatever address they spell, like 127.0.0.1.nip.io.
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/.test(d)) return null;
  return d;
}

/**
 * The URL when the favicon fetcher may request it: http or https, a host cleanIconDomain accepts (the URL parser has
 * already turned decimal, hex and octal IPs into dotted ones, and IPv6 into brackets, which it rejects), the default
 * port and no credentials. Null otherwise.
 */
export function safeIconUrl(input: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  return cleanIconDomain(url.hostname) === url.hostname.toLowerCase().replace(/\.$/, '') ? url : null;
}

/** Read at most `max` bytes of a body. Returns null when it is longer. */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const len = Number(res.headers.get('content-length'));
  if (len > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The first `max` bytes of a body, cut there. */
async function readHead(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, out.length - at);
    out.set(take, at);
    at += take.byteLength;
    if (at >= out.length) break;
  }
  return new TextDecoder().decode(out);
}

/** The href of the first <link rel="icon"> (or "shortcut icon", "apple-touch-icon") in an HTML head. */
export function iconHref(html: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase() ?? '';
    if (!rel.split(/\s+/).some((r) => r === 'icon' || r === 'apple-touch-icon')) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    if (v) return v.replace(/&amp;/g, '&');
  }
  return null;
}

/**
 * GET `url`, following up to 3 redirects by hand so each hop's host is checked (safeIconUrl). The response, with the
 * URL it came from, or null when a hop is refused, there are too many, or the fetch fails. One 4 s timeout covers all hops.
 */
async function get(url: string, fetchFn: typeof fetch): Promise<{ res: Response; url: string } | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let next = safeIconUrl(url);
  for (let hop = 0; next && hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetchFn(next.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': 'FounderData favicon fetcher', accept: 'image/*,text/html;q=0.9' },
        signal,
      });
    } catch {
      return null;
    }
    if (res.status < 300 || res.status > 399) return { res, url: next.toString() };
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (!location) return null;
    next = safeIconUrl(location, next.toString());
  }
  return null;
}

/** An image response from `url`, or null when it is not an image, too large or fails. */
async function image(url: string, fetchFn: typeof fetch): Promise<{ type: string; body: Uint8Array<ArrayBuffer> } | null> {
  const got = await get(url, fetchFn);
  const res = got?.res;
  if (!res?.ok) {
    await res?.body?.cancel();
    return null;
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_RE.test(type)) {
    await res.body?.cancel();
    return null;
  }
  const body = await readCapped(res, MAX_ICON_BYTES);
  return body && body.byteLength ? { type, body } : null;
}

/** Find a domain's icon: /favicon.ico first, then the first icon link on its home page. */
export async function findIcon(domain: string, fetchFn: typeof fetch = fetch): Promise<{ type: string; body: Uint8Array<ArrayBuffer> } | null> {
  const ico = await image(`https://${domain}/favicon.ico`, fetchFn);
  if (ico) return ico;
  const got = await get(`https://${domain}/`, fetchFn);
  if (!got) return null;
  const page = got.res;
  if (!page.ok || !(page.headers.get('content-type') ?? '').toLowerCase().includes('html')) {
    await page.body?.cancel();
    return null;
  }
  const href = iconHref(await readHead(page, MAX_HTML_BYTES));
  if (!href || href.startsWith('data:')) return null;
  // Checked again in get(): an icon link to another host must name a public host too.
  const url = safeIconUrl(href, got.url);
  return url ? image(url.toString(), fetchFn) : null;
}

/** The Cache API in the data center, or none (tests, local runs without it). */
function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' && (caches as unknown as { default?: Cache }).default ? (caches as unknown as { default: Cache }).default : null;
}

/** GET /api/favicon/:domain. */
export async function handleFavicon(c: Context<AppEnv>, fetchFn: typeof fetch = fetch) {
  const domain = cleanIconDomain(c.req.param('domain') ?? '');
  if (!domain) return c.json({ error: 'not a domain' }, 404);
  const cache = edgeCache();
  // Keyed by domain only: the answer is the same for everyone, and the auth check above already ran.
  const key = new Request(`https://favicon.founderdata.internal/${domain}`);
  const hit = await cache?.match(key);
  if (hit) return withPrivate(hit);

  const icon = await findIcon(domain, fetchFn);
  const res = icon
    ? new Response(icon.body, {
        headers: {
          'content-type': icon.type,
          'cache-control': `public, max-age=${HIT_TTL}`,
          'x-content-type-options': 'nosniff',
          // An SVG icon can hold script; this keeps it inert when opened directly.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      })
    : new Response(JSON.stringify({ error: 'no icon' }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${MISS_TTL}` },
      });
  if (cache) c.executionCtx.waitUntil(cache.put(key, res.clone()).catch(() => undefined));
  return withPrivate(res);
}

/** The browser keeps an icon as long as the edge does, but only for this login. */
function withPrivate(res: Response): Response {
  const out = new Response(res.body, res);
  const ttl = res.status === 200 ? HIT_TTL : MISS_TTL;
  out.headers.set('cache-control', `private, max-age=${ttl}`);
  return out;
}
