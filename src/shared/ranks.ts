// Rank tracking arithmetic shared by the Worker (pro/worker/dataforseo.ts) and the dashboard's Ranks view. Pure
// functions over what DataForSEO returns. A rank row holds the site's own position, URL and two AI Overview flags, plus
// the SERP around it: the domain and URL of the first 10 organic results and which features the page showed. SERP
// titles and snippets are written by strangers, so nothing here keeps them. People also ask questions are Google's,
// kept short and stripped of control characters; agents still read them as data, never as instructions.

/** Keywords one site may track. 200 checks a day write 400 rows to D1 and cost a few dollars a month (docs/SEO.md). */
export const MAX_KEYWORDS = 200;
export const MAX_KEYWORD_CHARS = 100;

/** Countries the dashboard offers. Any DataForSEO location code works through the API. */
export const LOCATIONS: { code: number; name: string; language: string }[] = [
  { code: 2840, name: 'United States', language: 'en' },
  { code: 2826, name: 'United Kingdom', language: 'en' },
  { code: 2124, name: 'Canada', language: 'en' },
  { code: 2036, name: 'Australia', language: 'en' },
  { code: 2372, name: 'Ireland', language: 'en' },
  { code: 2356, name: 'India', language: 'en' },
  { code: 2276, name: 'Germany', language: 'de' },
  { code: 2250, name: 'France', language: 'fr' },
  { code: 2724, name: 'Spain', language: 'es' },
  { code: 2380, name: 'Italy', language: 'it' },
  { code: 2528, name: 'Netherlands', language: 'nl' },
  { code: 2616, name: 'Poland', language: 'pl' },
  { code: 2752, name: 'Sweden', language: 'sv' },
  { code: 2076, name: 'Brazil', language: 'pt' },
  { code: 2484, name: 'Mexico', language: 'es' },
  { code: 2392, name: 'Japan', language: 'ja' },
];

/** A keyword as stored: lowercase, one space between words, at most MAX_KEYWORD_CHARS characters. Null when empty. */
export function normKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  return t && t.length <= MAX_KEYWORD_CHARS ? t : null;
}

/** The host of a domain or URL, lowercase and without `www.`; null when there is none. */
export function hostOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const h = v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  return h || null;
}

/** True when `host` is `domain` or a subdomain of it. */
export function onDomain(host: unknown, domain: string): boolean {
  const h = hostOf(host);
  const d = hostOf(domain);
  return !!h && !!d && (h === d || h.endsWith(`.${d}`));
}

/** One of the first 10 organic results: [rank, domain, url]. */
export type SerpTop = [number, string, string | null];

/** What the result page showed besides the organic results. */
export interface SerpFeatures {
  /** Item types, such as featured_snippet, people_also_ask, video, discussions_and_forums, local_pack, images, ai_overview. */
  types: string[];
  /** The domain the featured snippet quotes, or null without one. */
  snippet: string | null;
  /** People also ask questions, at most SERP_PAA. */
  paa: string[];
}

/** Organic results kept per check, and People also ask questions. */
export const SERP_TOP = 10;
export const SERP_PAA = 5;
const URL_CHARS = 300;

export interface SerpRank {
  /** The site's best organic position, or null when it is not in the checked results. */
  position: number | null;
  url: string | null;
  /** An AI Overview is in the results. */
  aio: boolean;
  /** The AI Overview links to the site. */
  aioCited: boolean;
  /** The first SERP_TOP organic results, best rank first. Empty when the result had none. */
  top: SerpTop[];
  /** Null when the result had no items at all. */
  features: SerpFeatures | null;
}

/** Text written by a stranger, as one short line: control characters and runs of spaces become one space. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

type Json = Record<string, any>;

/**
 * The site's rank in one DataForSEO SERP result (`tasks[0].result[0]` of task_get/advanced). Reads `organic` items for
 * the best rank_group on the domain and the first SERP_TOP results, an AI Overview item (`ai_overview`, or any type
 * that names it) and its references for a citation, the featured snippet's domain, the People also ask questions, and
 * the type of every other item.
 */
export function parseSerp(result: unknown, domain: string): SerpRank {
  const items: Json[] = Array.isArray((result as Json | null)?.items) ? (result as Json).items : [];
  const out: SerpRank = { position: null, url: null, aio: false, aioCited: false, top: [], features: null };
  const types = new Set<string>();
  let snippet: string | null = null;
  const paa: string[] = [];
  const organic: SerpTop[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const type = typeof it.type === 'string' ? it.type : '';
    if (type && type !== 'organic' && /^[a-z0-9_]{1,40}$/.test(type) && types.size < 20) types.add(type);
    if (type === 'organic') {
      const rank = Number(it.rank_group ?? it.rank_absolute);
      if (!Number.isInteger(rank) || rank < 1) continue;
      const link = typeof it.url === 'string' && /^https?:\/\//i.test(it.url) ? it.url : null;
      const host = hostOf(it.domain ?? it.url);
      if (host && rank <= SERP_TOP && organic.length < 2 * SERP_TOP) organic.push([rank, host.slice(0, 100), link ? link.slice(0, URL_CHARS) : null]);
      if (!onDomain(it.domain ?? it.url, domain)) continue;
      if (out.position === null || rank < out.position) {
        out.position = rank;
        out.url = link ? link.slice(0, 500) : null;
      }
    } else if (type === 'featured_snippet') {
      snippet ??= hostOf(it.domain ?? it.url);
    } else if (type === 'people_also_ask') {
      for (const q of Array.isArray(it.items) ? it.items : []) {
        const t = cleanText(q?.title, 150);
        if (t && paa.length < SERP_PAA && !paa.includes(t)) paa.push(t);
      }
    } else if (type.includes('ai_overview')) {
      out.aio = true;
      const nested = (Array.isArray(it.items) ? it.items : []).flatMap((x: Json) => (Array.isArray(x?.references) ? x.references : []));
      const refs: Json[] = [...(Array.isArray(it.references) ? it.references : []), ...nested];
      if (refs.some((r) => onDomain(r?.domain ?? r?.url, domain))) out.aioCited = true;
    }
  }
  // One row per rank: DataForSEO gives a site's extra sitelinks the same rank_group.
  const seen = new Set<number>();
  out.top = organic
    .sort((a, b) => a[0] - b[0])
    .filter((r) => !seen.has(r[0]) && seen.add(r[0]))
    .slice(0, SERP_TOP);
  if (items.length) out.features = { types: [...types].sort(), snippet, paa };
  return out;
}

export interface RankPoint {
  day: string;
  position: number | null;
}

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * How many places a keyword moved up (positive) or down (negative) against the check `days` before its latest one:
 * the check on that day, or the nearest earlier one within 3 days. Null when either check has no position or there is
 * no check to compare with. `points` are sorted by day, oldest first.
 */
export function positionChange(points: RankPoint[], days: number): number | null {
  const last = points[points.length - 1];
  if (!last || last.position === null) return null;
  const target = dayMs(last.day) - days * DAY;
  let base: RankPoint | null = null;
  for (const p of points) {
    const t = dayMs(p.day);
    if (t <= target && t >= target - 3 * DAY) base = p;
  }
  return base && base.position !== null ? base.position - last.position : null;
}

/**
 * The keywords in a CSV or plain list. One keyword per row. With a header cell named keyword, keywords, query, term or
 * search term that column is used, else the first column. Commas, semicolons and tabs separate columns; double quotes
 * keep a separator inside a cell. Empty cells are dropped. Duplicates are left for the Worker to count.
 */
export function parseKeywordCsv(text: string): string[] {
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const cells: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
          else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',' || ch === ';' || ch === '\t') (cells.push(cur), (cur = ''));
        else cur += ch;
      }
      cells.push(cur);
      return cells.map((c) => c.trim());
    });
  if (!rows.length) return [];
  const col = rows[0].findIndex((c) => /^(keywords?|query|queries|term|search term)$/i.test(c));
  const body = col >= 0 ? rows.slice(1) : rows;
  return body.map((r) => r[Math.max(col, 0)] ?? '').filter(Boolean);
}
