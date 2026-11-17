// The page audit: flags over the `site_inventory` part of the SEO snapshot (docs/SEO.md, "Page audit"). The SEO tab
// runs this in the browser and GET /api/v1/seo/audit in the Worker, so an agent and the tab agree.
//
// A URL whose fetch failed has `status: null`. That is "not measured": it counts under `not_fetched` and gets no flag.
// A field that is null was not measured either, so its check skips the URL instead of guessing.

export interface InventoryPage {
  /** A URL or a path. */
  url: string;
  /** HTTP status of the URL, after no redirects. null: the fetch failed. */
  status: number | null;
  /** The URL a redirect ended on, or null. */
  finalUrl?: string | null;
  title: string | null;
  /** Characters of the title; when absent, the length of `title`. */
  titleLength?: number | null;
  /** Characters of the meta description; 0 means it has none. */
  metaDescriptionLength: number | null;
  /** The meta description itself, when the crawler sends it. SEO opportunities show it beside the page. */
  metaDescription?: string | null;
  canonical: string | null;
  /** false when a robots meta tag or X-Robots-Tag says noindex. */
  indexable: boolean | null;
  schemaTypes: string[];
  wordCount: number | null;
  /** Internal links pointing at the URL from the other crawled pages; null when the crawler does not count them. */
  linksIn: number | null;
  /** Internal links on the page. */
  linksOut: number | null;
  /** YYYY-MM-DD the URL was crawled. */
  observed: string;
}

export interface SiteInventory {
  version: 1;
  /** YYYY-MM-DD of the crawl, or of its last URL. */
  observedAt: string;
  /** Which tool crawled, for the reader. */
  source?: string | null;
  pages: InventoryPage[];
}

export const AUDIT_FLAGS = ['non_200', 'noindex', 'missing_meta', 'title_too_long', 'thin', 'orphaned'] as const;
export type AuditFlag = (typeof AUDIT_FLAGS)[number];

/** Above this many characters Google usually cuts a title in results. */
export const TITLE_MAX = 60;
/** Fewer words than this on a 200 page is thin. */
export const THIN_WORDS = 300;
/** A crawl older than this many days is stale: the pages may have changed since, so its flags may be wrong. */
export const AUDIT_STALE_DAYS = 30;

/** Whole days since the crawl (`observedAt`, else `pushedAt` in ms), and whether that passes AUDIT_STALE_DAYS. */
export function crawlAge(observedAt: string | null, pushedAt: number | null, now: number): { age_days: number | null; stale: boolean } {
  const day = observedAt?.slice(0, 10) ?? '';
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : pushedAt;
  if (at === null || !Number.isFinite(at)) return { age_days: null, stale: false };
  const age = Math.max(0, Math.floor((now - at) / 86_400_000));
  return { age_days: age, stale: age > AUDIT_STALE_DAYS };
}

export const FLAG_LABEL: Record<AuditFlag, string> = {
  non_200: 'Not 200',
  noindex: 'Noindex',
  missing_meta: 'No meta description',
  title_too_long: `Title over ${TITLE_MAX} characters`,
  thin: `Under ${THIN_WORDS} words`,
  orphaned: 'No internal links in',
};

export interface AuditedPage extends InventoryPage {
  flags: AuditFlag[];
}

export interface Audit {
  observedAt: string | null;
  urls: number;
  /** URLs that answered 200: the ones the content checks run on. */
  ok: number;
  /** URLs whose fetch failed: not measured, no flag. */
  notFetched: number;
  counts: Record<AuditFlag, number>;
  /** Per flag, the 200 URLs its check could not run on because the field was null. */
  notMeasured: Record<AuditFlag, number>;
  pages: AuditedPage[];
}

const zero = () => Object.fromEntries(AUDIT_FLAGS.map((f) => [f, 0])) as Record<AuditFlag, number>;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Is `x` a site_inventory part this code can read? */
export function isInventory(x: unknown): x is SiteInventory {
  return !!x && typeof x === 'object' && Array.isArray((x as SiteInventory).pages);
}

/** The flags of one URL, and which checks it could not be measured on. */
export function flagsOf(p: InventoryPage): { flags: AuditFlag[]; unmeasured: AuditFlag[] } {
  const status = num(p.status);
  if (status === null) return { flags: [], unmeasured: [] };
  if (status !== 200) return { flags: ['non_200'], unmeasured: [] };
  const flags: AuditFlag[] = [];
  const unmeasured: AuditFlag[] = [];
  const check = (f: AuditFlag, v: boolean | null) => (v === null ? unmeasured.push(f) : v && flags.push(f));
  check('noindex', typeof p.indexable === 'boolean' ? !p.indexable : null);
  const meta = num(p.metaDescriptionLength);
  check('missing_meta', meta === null ? null : meta === 0);
  const title = num(p.titleLength) ?? (typeof p.title === 'string' ? p.title.length : null);
  check('title_too_long', title === null ? null : title > TITLE_MAX);
  const words = num(p.wordCount);
  check('thin', words === null ? null : words < THIN_WORDS);
  const linksIn = num(p.linksIn);
  check('orphaned', linksIn === null ? null : linksIn === 0);
  return { flags, unmeasured };
}

/** Every URL with its flags, flagged ones first (most flags first, then by URL). */
export function auditInventory(inv: SiteInventory): Audit {
  const counts = zero();
  const notMeasured = zero();
  let ok = 0;
  let notFetched = 0;
  const pages = inv.pages
    .filter((p) => p && typeof p.url === 'string')
    .map((p) => {
      if (num(p.status) === null) notFetched++;
      else if (p.status === 200) ok++;
      const { flags, unmeasured } = flagsOf(p);
      for (const f of flags) counts[f]++;
      for (const f of unmeasured) notMeasured[f]++;
      return { ...p, flags };
    })
    .sort((a, b) => b.flags.length - a.flags.length || a.url.localeCompare(b.url));
  return { observedAt: typeof inv.observedAt === 'string' ? inv.observedAt : null, urls: pages.length, ok, notFetched, counts, notMeasured, pages };
}
