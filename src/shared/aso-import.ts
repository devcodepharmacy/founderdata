/**
 * Read a keyword list or a keyword CSV for the ASO tab (docs/ASO.md, "Import keywords"). The dashboard shows a
 * preview with it and the Worker (`POST /api/sites/:id/aso/keywords` with `csv`) saves with it, so both read a file the
 * same way. It is pure: no network, no storage.
 *
 * Accepted:
 * - one keyword per line, or keywords separated by commas on one line
 * - `keyword,country` lines, the country as a code (`de`), a name (`Germany`) or Astro's `🇩🇪 DE`
 * - a CSV with a header row. The keyword column is named keyword, keywords, term, search term or query. The country
 *   column is named country, store domain, storefront, store, region or locale. Astro's export has "Store Domain" with
 *   the code and "Store" with the flag and the name, and the code column wins.
 * - A Ranking (or Rank) column holds the rank on the day of the export. It is returned in `ranks`, one per keyword and
 *   country, and the Worker stores it as that day's rank with the source "import" (docs/ASO.md, "Import keywords"). A
 *   file without a country column has no rank to place, so its ranks are not read.
 * - Astro's other columns (App Name, App Id, Platform, Note, Last Update, Change, Popularity, Difficulty, Apps in
 *   Ranking, Tags) are read for the app only. Popularity and difficulty are not imported: FounderData reads popularity
 *   from Apple Ads and works out difficulty from the top 10.
 */

/**
 * Longest keyword file the Worker reads, in characters. Parsing costs about 0.05 ms per KB at worst (a list of short
 * keywords, or a CSV that names its countries), so 60 KB parses in under 5 ms of the free plan's 10 ms.
 */
export const MAX_IMPORT_CHARS = 60_000;

export interface ImportRow {
  keyword: string;
  country: string | null;
}

export interface ImportApp {
  id: string;
  name: string | null;
  rows: number;
}

export interface KeywordImport {
  format: 'list' | 'csv' | 'astro';
  /** Keywords in file order, cleaned and without duplicates. */
  keywords: string[];
  /** Valid country codes found, in file order, without duplicates. */
  countries: string[];
  /** Country values that match no App Store country. */
  unknownCountries: string[];
  /** Apps named in the file (an Astro export can hold several). Empty without an app column. */
  apps: ImportApp[];
  /** The app whose rows were kept: an id, or null for every row. */
  appId: string | null;
  /** Rows left out because they belong to another app in the file. */
  otherApps: number;
  /** Rows kept, after other apps' rows, empty keywords and repeats. */
  rows: number;
  /** Rows with an empty or over-long keyword. */
  invalid: number;
  /** Rows repeating a keyword and country already seen. */
  duplicates: number;
  /** The file had popularity, difficulty or change columns, which are not imported. */
  ignoredColumns: string[];
  /** The ranks the file carries for a keyword and country, 1 to 1000. A blank, "-" or 0 is no rank and is left out. */
  ranks: { keyword: string; country: string; rank: number }[];
  /** The file has a Ranking column, whether or not a row had a rank. */
  hasRankColumn: boolean;
}

const KEYWORD_HEADERS = ['keyword', 'keywords', 'term', 'search term', 'searchterm', 'query', 'search query'];
const COUNTRY_HEADERS = ['store domain', 'country', 'country code', 'storefront', 'region', 'locale', 'store'];
const APP_ID_HEADERS = ['app id', 'appid', 'app store id', 'apple id'];
const APP_NAME_HEADERS = ['app name', 'app'];
const RANK_HEADERS = ['ranking', 'rank', 'current rank'];
const IGNORED_HEADERS = ['popularity', 'difficulty', 'change', 'apps in ranking', 'tags', 'note'];
const ALIASES: Record<string, string> = { uk: 'gb', usa: 'us', 'united states of america': 'us', 'great britain': 'gb', 'united kingdom': 'gb', korea: 'kr', 'south korea': 'kr', russia: 'ru', vietnam: 'vn' };

export function cleanKeyword(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const k = v.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!k || k.length > 100 || /[\u0000-\u001f\u007f]/.test(k)) return null;
  return k;
}

/** Rows of fields, with quotes and a delimiter that may sit inside a quoted field. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  endRow();
  return rows;
}

/** The delimiter the first lines use most: comma, semicolon or tab. Comma when none appears. */
function delimiterOf(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5).join('\n');
  let best = ',';
  let most = 0;
  for (const d of [',', ';', '\t']) {
    let n = 0;
    let quoted = false;
    for (const ch of sample) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) n++;
    }
    if (n > most) {
      most = n;
      best = d;
    }
  }
  return best;
}

let names: Map<string, string> | null = null;

/** A country value as an App Store country code, or null. Takes `de`, `DE`, `Germany`, `🇩🇪 DE` and `UK`. */
export function countryCode(value: string, valid: Set<string>): string | null {
  const v = value
    .normalize('NFC')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[^\p{L}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!v) return null;
  if (ALIASES[v] && valid.has(ALIASES[v])) return ALIASES[v];
  if (v.length === 2) return valid.has(v) ? v : null;
  if (!names) {
    names = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = dn.of(code);
          if (name && name !== code) names.set(name.toLowerCase(), code.toLowerCase());
        }
      }
    } catch {
      // No region names in this runtime: codes still work.
    }
  }
  const byName = names.get(v);
  return byName && valid.has(byName) ? byName : null;
}

const norm = (h: string) => h.normalize('NFC').replace(/^﻿/, '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

export function parseKeywordImport(input: string, opts: { countries: Set<string>; appId?: string | null | 'all' }): KeywordImport {
  const text = input.replace(/^﻿/, '');
  const out: KeywordImport = { format: 'list', keywords: [], countries: [], unknownCountries: [], apps: [], appId: null, rows: 0, otherApps: 0, invalid: 0, duplicates: 0, ignoredColumns: [], ranks: [], hasRankColumn: false };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return out;

  const delimiter = delimiterOf(text);
  const table = parseDelimited(text, delimiter);
  const head = table[0].map(norm);
  const kwCol = head.findIndex((h) => KEYWORD_HEADERS.includes(h));

  // Each source row becomes { keyword, country text, app id, app name }.
  let source: { keyword: string; country: string | null; appId: string | null; appName: string | null; rank?: string }[] = [];
  if (kwCol >= 0) {
    // Astro puts the code in "Store Domain" and the flag with the name in "Store": take the first header that exists.
    const ccCol = COUNTRY_HEADERS.map((h) => head.indexOf(h)).find((i) => i >= 0) ?? -1;
    const idCol = APP_ID_HEADERS.map((h) => head.indexOf(h)).find((i) => i >= 0) ?? -1;
    const nameCol = APP_NAME_HEADERS.map((h) => head.indexOf(h)).find((i) => i >= 0) ?? -1;
    const rankCol = RANK_HEADERS.map((h) => head.indexOf(h)).find((i) => i >= 0) ?? -1;
    out.hasRankColumn = rankCol >= 0;
    out.format = head.includes('store domain') ? 'astro' : 'csv';
    out.ignoredColumns = IGNORED_HEADERS.filter((h) => head.includes(h) && !(h === 'note' || h === 'tags'));
    source = table.slice(1).map((r) => ({
      keyword: r[kwCol] ?? '',
      country: ccCol >= 0 ? (r[ccCol] ?? '').trim() || null : null,
      appId: idCol >= 0 ? (r[idCol] ?? '').trim().replace(/^id/i, '') || null : null,
      appName: nameCol >= 0 ? (r[nameCol] ?? '').trim() || null : null,
      rank: rankCol >= 0 ? (r[rankCol] ?? '').trim() : undefined,
    }));
  } else {
    // No header: a keyword per line, or `keyword,country`, or one line of keywords separated by commas.
    for (const line of lines) {
      const fields = parseDelimited(line, delimiter)[0] ?? [];
      const last = fields.length > 1 ? fields[fields.length - 1] : '';
      if (fields.length === 2 && countryCode(last, opts.countries)) {
        source.push({ keyword: fields[0], country: last.trim(), appId: null, appName: null });
      } else if (delimiter === ',' && fields.length > 1) {
        for (const f of fields) source.push({ keyword: f, country: null, appId: null, appName: null });
      } else source.push({ keyword: delimiter === '\t' || delimiter === ';' ? line : (fields[0] ?? line), country: null, appId: null, appName: null });
    }
  }

  // Which app's rows to keep.
  const apps = new Map<string, ImportApp>();
  for (const r of source) {
    if (!r.appId) continue;
    const a = apps.get(r.appId) ?? { id: r.appId, name: r.appName, rows: 0 };
    a.rows++;
    apps.set(r.appId, a);
  }
  out.apps = [...apps.values()];
  let keep: string | null = null;
  if (out.apps.length) {
    const asked = opts.appId ?? null;
    if (asked && asked !== 'all' && apps.has(asked)) keep = asked;
    else if (!asked && out.apps.length === 1) keep = out.apps[0].id;
    else if (!asked) keep = null;
  }
  out.appId = keep;

  const seen = new Set<string>();
  const kws = new Set<string>();
  const ccs = new Set<string>();
  const unknown = new Set<string>();
  for (const r of source) {
    if (keep && r.appId && r.appId !== keep) {
      out.otherApps++;
      continue;
    }
    const keyword = cleanKeyword(r.keyword.replace(/^"+|"+$/g, ''));
    if (!keyword) {
      out.invalid++;
      continue;
    }
    let country: string | null = null;
    if (r.country) {
      country = countryCode(r.country, opts.countries);
      if (country) ccs.add(country);
      else unknown.add(r.country);
    }
    const key = `${keyword}|${country ?? ''}`;
    if (seen.has(key)) {
      out.duplicates++;
      continue;
    }
    seen.add(key);
    kws.add(keyword);
    const n = r.rank !== undefined && /^\d{1,4}$/.test(r.rank) ? Number(r.rank) : 0;
    if (country && n >= 1 && n <= 1000) out.ranks.push({ keyword, country, rank: n });
  }
  out.rows = seen.size;
  out.keywords = [...kws];
  out.countries = [...ccs];
  out.unknownCountries = [...unknown];
  return out;
}
