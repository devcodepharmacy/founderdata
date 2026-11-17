#!/usr/bin/env node
// FounderData Search Console sync (docs/SEO.md, "Sync Search Console"). Pulls clicks, impressions and position from
// the Search Console API and pushes them as the SEO snapshot's gsc_daily, gsc_queries, gsc_pages, gsc_page_queries,
// gsc_page_totals and gsc_query_totals parts, so you don't write your own exporter. It also moves `meta.property` and `meta.gscThrough` and leaves every other field of
// `meta` (keyword targets, plan, ship log, AI answers) as it finds it.
//
//   node scripts/gsc-sync.mjs --url https://founderdata.example.com --site SITE_ID --property sc-domain:acme.example
//   node scripts/gsc-sync.mjs --config ~/.config/founderdata/gsc-sync.json      several sites in one run
//   node scripts/gsc-sync.mjs ... --dry-run                                     pull and summarise, push nothing
//   node scripts/gsc-sync.mjs --help
//
// No dependencies, Node 20 or later.
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = 'gsc-sync/1';
export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API = 'https://searchconsole.googleapis.com/webmasters/v3';
/** The Worker refuses a part over this many bytes (pro/worker/seo.ts, MAX_PART_BYTES). */
export const MAX_PART_BYTES = 1_900_000;
const PAGE_ROWS = 25_000;
const DEFAULT_DAYS = 90;
/** Search Console keeps 16 months. */
const MAX_DAYS = 480;
/** Rows pulled per part before the size cut. One API request is 25,000 rows. */
const DEFAULT_MAX_ROWS = 200_000;
/** gsc_page_queries: two windows of this many days, ending on the last Search Console day (src/shared/seo-insights.ts). */
export const PAGE_QUERY_DAYS = 28;
/** Page and query pairs gsc_page_queries keeps, the most clicked over both windows first. */
export const PAGE_QUERY_ROWS = 5000;
/** Pairs pulled per window before that cut: one API request. */
const PAGE_QUERY_PULL = 25_000;
/** gsc_page_totals and gsc_query_totals: the last days of the 28-day window that count as recent (src/shared/seo-insights.ts). */
export const RECENT_DAYS = 7;
/** Pages or queries pulled per window for the totals parts. */
const TOTALS_PULL = 50_000;
/** Search Console reports final data about two days late. */
const LAG_DAYS = 2;
const CONFIG_DIR = path.join(homedir(), '.config', 'founderdata');

const DAY = 86_400_000;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// ---------- Google sign-in

const b64url = (v) => Buffer.from(v).toString('base64url');

/** The claims Google wants in a service account's JWT: who signs, what for, where it goes and for how long. */
export function jwtClaims({ clientEmail, now = Date.now(), scope = SCOPE, audience = TOKEN_URL, lifetime = 3600 }) {
  const iat = Math.floor(now / 1000);
  return { iss: clientEmail, scope, aud: audience, iat, exp: iat + lifetime };
}

/** A compact RS256 JWT: `header.claims.signature`, each part base64url, signed with the account's private key. */
export function signJwt(claims, privateKey) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/** The form body for oauth2.googleapis.com/token: a signed JWT for a service account, a refresh token for OAuth. */
export function tokenRequest(creds, now = Date.now()) {
  if (creds.kind === 'service-account') {
    return new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(jwtClaims({ clientEmail: creds.clientEmail, now }), creds.privateKey),
    });
  }
  return new URLSearchParams({ grant_type: 'refresh_token', client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken });
}

/**
 * Credentials from a parsed JSON file or from environment variables. A service account key file has
 * `type: "service_account"`, `client_email` and `private_key`. An OAuth file has `client_id`, `client_secret` and
 * `refresh_token` (Google's `installed` or `web` wrapper around the client is fine). Returns null for neither.
 */
export function parseCredentials(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.client_email === 'string' && typeof json.private_key === 'string') {
    return { kind: 'service-account', clientEmail: json.client_email, privateKey: json.private_key };
  }
  const client = json.installed ?? json.web ?? json;
  const clientId = client.client_id ?? json.client_id;
  const clientSecret = client.client_secret ?? json.client_secret;
  if (clientId && clientSecret && json.refresh_token) return { kind: 'oauth', clientId, clientSecret, refreshToken: json.refresh_token };
  return null;
}

export function loadCredentials({ file, env = process.env }) {
  if (env.GSC_CLIENT_ID && env.GSC_CLIENT_SECRET && env.GSC_REFRESH_TOKEN && !file) {
    return { kind: 'oauth', clientId: env.GSC_CLIENT_ID, clientSecret: env.GSC_CLIENT_SECRET, refreshToken: env.GSC_REFRESH_TOKEN };
  }
  const candidates = [file, env.GSC_CREDENTIALS, path.join(CONFIG_DIR, 'gsc-credentials.json')].filter(Boolean);
  const found = candidates.find((f) => existsSync(f));
  if (!found) {
    throw new Error(
      `No Google credentials. Put the service account key in ${path.join(CONFIG_DIR, 'gsc-credentials.json')}, or pass --credentials <file> or set GSC_CREDENTIALS. ` +
        'For OAuth set GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN.',
    );
  }
  let json;
  try {
    json = JSON.parse(readFileSync(found, 'utf8'));
  } catch {
    throw new Error(`${found} is not JSON.`);
  }
  const creds = parseCredentials(json);
  if (!creds) throw new Error(`${found} is neither a service account key (client_email, private_key) nor an OAuth file (client_id, client_secret, refresh_token).`);
  return creds;
}

/** Exchange the credentials for an access token that lasts about an hour. */
export async function accessToken(creds, { fetcher = fetch, now = Date.now() } = {}) {
  const res = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenRequest(creds, now) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the sign-in (${res.status}): ${body.error_description ?? body.error ?? res.statusText}`);
  }
  return body.access_token;
}

// ---------- Search Console

/** `sc-domain:acme.example` stays; a URL-prefix property needs its trailing slash, which is easy to forget. */
export function normalizeProperty(property) {
  const p = String(property ?? '').trim();
  if (/^sc-domain:[^/\s]+$/i.test(p)) return 'sc-domain:' + p.slice('sc-domain:'.length).toLowerCase();
  if (/^https?:\/\/[^\s]+$/i.test(p)) return p.endsWith('/') ? p : p + '/';
  throw new Error(`"${p}" is not a Search Console property. Use sc-domain:acme.example or https://acme.example/.`);
}

/** The `days` days ending `LAG_DAYS` before `today` (a `YYYY-MM-DD` string), both ends included. */
export function dateRange(days, today) {
  const n = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(days)) || DEFAULT_DAYS));
  const endDate = addDays(today, -LAG_DAYS);
  return { startDate: addDays(endDate, -(n - 1)), endDate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every row of one searchAnalytics.query, 25,000 a request. Search Console sorts by clicks, so stopping at `maxRows`
 * drops the least-clicked rows. Retries 429 and 5xx answers.
 */
export async function queryAll({ token, property, startDate, endDate, dimensions, maxRows = DEFAULT_MAX_ROWS, fetcher = fetch, wait = sleep }) {
  const url = `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const rows = [];
  for (let startRow = 0; rows.length < maxRows; startRow += PAGE_ROWS) {
    const rowLimit = Math.min(PAGE_ROWS, maxRows - rows.length);
    const payload = JSON.stringify({ startDate, endDate, dimensions, type: 'web', rowLimit, startRow });
    let body;
    for (let attempt = 0; ; attempt++) {
      const res = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload });
      body = await res.json().catch(() => ({}));
      if (res.ok) break;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await wait(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(searchConsoleError(res.status, body, property));
    }
    const page = Array.isArray(body.rows) ? body.rows : [];
    rows.push(...page);
    if (page.length < rowLimit) break;
  }
  return rows;
}

function searchConsoleError(status, body, property) {
  const why = body?.error?.message ?? body?.error_description ?? '';
  if (status === 403) return `Search Console refused ${property} (403)${why ? `: ${why}` : ''}. Add the service account's email as a user of the property (Search Console > Settings > Users and permissions), and enable the Search Console API in its Google Cloud project.`;
  if (status === 404) return `Search Console doesn't know ${property} (404). Check the spelling: sc-domain:acme.example or https://acme.example/ with the trailing slash.`;
  if (status === 401) return `Search Console rejected the access token (401)${why ? `: ${why}` : ''}.`;
  return `Search Console answered ${status}${why ? `: ${why}` : ''}`;
}

// ---------- rows to snapshot parts

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** A Search Console page URL as the entry page path FounderData stores: `https://acme.example/blog/x?utm=1#top` is `/blog/x`. */
export function normalizePath(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/')) return s.replace(/[?#].*$/, '') || '/';
  try {
    return new URL(s).pathname || '/';
  } catch {
    return null;
  }
}

/** `[date, clicks, impressions, position]` per day, oldest first. Position is Search Console's average, 2 decimals. */
export function dailyPart(rows) {
  const out = [];
  for (const r of rows) {
    const date = r?.keys?.[0];
    if (!isDay(date)) continue;
    const impressions = num(r.impressions);
    out.push([date, num(r.clicks), impressions, impressions > 0 && Number.isFinite(Number(r.position)) ? round(Number(r.position), 2) : null]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * `[date, key, clicks, impressions, position]` per day and key, from rows with `keys: [date, query or page]`.
 * `keyOf` turns the raw key into the stored one (the page path); rows whose keys come out the same (a page with and
 * without a tracking parameter, `www` and the bare host) add up, with position weighted by impressions.
 */
export function keyedPart(rows, keyOf = (k) => k) {
  const merged = new Map();
  for (const r of rows) {
    const date = r?.keys?.[0];
    const key = keyOf(r?.keys?.[1]);
    if (!isDay(date) || !key) continue;
    const id = `${date}\u0000${key}`;
    const impressions = num(r.impressions);
    const m = merged.get(id) ?? { date, key, clicks: 0, impressions: 0, weighted: 0 };
    m.clicks += num(r.clicks);
    m.impressions += impressions;
    m.weighted += num(r.position) * impressions;
    merged.set(id, m);
  }
  return [...merged.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.clicks - a.clicks || (a.key < b.key ? -1 : 1)))
    .map((m) => [m.date, m.key, m.clicks, m.impressions, m.impressions > 0 ? round(m.weighted / m.impressions, 2) : null]);
}

export const queriesPart = (rows) => keyedPart(rows);
export const pagesPart = (rows) => keyedPart(rows, normalizePath);

export const partBytes = (rows) => Buffer.byteLength(JSON.stringify(rows));

/** The `days` days ending on `last` and the same number of days before, as the dashboard's windowEnding. */
export function pageQueryWindow(last, days = PAGE_QUERY_DAYS) {
  const from = addDays(last, -(days - 1));
  return { from, to: last, previousFrom: addDays(from, -days), previousTo: addDays(from, -1) };
}

/**
 * The gsc_page_queries part from two pulls with `keys: [page, query]`, one per window. Page URLs become paths and
 * pairs that come out the same add up. Keeps the `cap` pairs with the most clicks over both windows (then
 * impressions), so a query a decaying page lost stays in. Rows: [page, query, clicks, impressions, position,
 * previous clicks, previous impressions, previous position].
 */
export function pageQueriesPart(current, previous, window, { cap = PAGE_QUERY_ROWS, limit = MAX_PART_BYTES } = {}) {
  const merged = new Map();
  const add = (rows, side) => {
    for (const r of rows) {
      const page = normalizePath(r?.keys?.[0]);
      const query = r?.keys?.[1];
      if (!page || typeof query !== 'string' || !query) continue;
      const id = `${page}\u0000${query}`;
      const m = merged.get(id) ?? { page, query, s: [{ clicks: 0, impressions: 0, weighted: 0 }, { clicks: 0, impressions: 0, weighted: 0 }] };
      const x = m.s[side];
      const impressions = num(r.impressions);
      x.clicks += num(r.clicks);
      x.impressions += impressions;
      x.weighted += num(r.position) * impressions;
      merged.set(id, m);
    }
  };
  add(current, 0);
  add(previous, 1);
  const pos = (x) => (x.impressions > 0 ? round(x.weighted / x.impressions, 2) : null);
  const ranked = [...merged.values()].sort(
    (a, b) =>
      b.s[0].clicks + b.s[1].clicks - (a.s[0].clicks + a.s[1].clicks) ||
      b.s[0].impressions + b.s[1].impressions - (a.s[0].impressions + a.s[1].impressions) ||
      (a.page < b.page ? -1 : a.page > b.page ? 1 : a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
  );
  let rows = ranked.slice(0, cap).map((m) => [m.page, m.query, m.s[0].clicks, m.s[0].impressions, pos(m.s[0]), m.s[1].clicks, m.s[1].impressions, pos(m.s[1])]);
  const part = () => ({ ...window, rows });
  // 5,000 pairs are about 500 KB. Very long URLs or queries could still pass the limit: drop the least clicked.
  while (rows.length && partBytes(part()) > limit) rows = rows.slice(0, Math.floor(rows.length * 0.9));
  return { part: part(), pairs: merged.size, droppedKeys: merged.size - rows.length };
}

/** The windows of gsc_page_totals and gsc_query_totals: the page and query pairs' two windows, plus the last RECENT_DAYS. */
export function totalsWindow(last) {
  return { ...pageQueryWindow(last), recentFrom: addDays(last, -(RECENT_DAYS - 1)) };
}

/**
 * A gsc_page_totals or gsc_query_totals part from three pulls with one dimension: the 28 days, the 28 before and the last
 * RECENT_DAYS. Rows: [key, clicks, impressions, position, previous clicks, previous impressions, previous position,
 * recent clicks, recent impressions], most clicked over both windows first. Pages become paths. `complete` is false
 * when a pull stopped at `cap` rows, `recentComplete` when the recent pull did. Keys past the byte limit are dropped, the least clicked first.
 */
export function totalsPart({ current, previous, recent }, window, { page = false, cap = TOTALS_PULL, limit = MAX_PART_BYTES } = {}) {
  const merged = new Map();
  const add = (rows, side) => {
    for (const r of rows) {
      const raw = r?.keys?.[0];
      const key = page ? normalizePath(raw) : typeof raw === 'string' ? raw : null;
      if (!key) continue;
      const m = merged.get(key) ?? [0, 1, 2].map(() => ({ clicks: 0, impressions: 0, weighted: 0 }));
      const impressions = num(r.impressions);
      m[side].clicks += num(r.clicks);
      m[side].impressions += impressions;
      m[side].weighted += num(r.position) * impressions;
      merged.set(key, m);
    }
  };
  add(current, 0);
  add(previous, 1);
  add(recent, 2);
  const pos = (x) => (x.impressions > 0 ? round(x.weighted / x.impressions, 2) : null);
  let rows = [...merged.entries()]
    .sort(([ka, a], [kb, b]) => b[0].clicks + b[1].clicks - (a[0].clicks + a[1].clicks) || b[0].impressions + b[1].impressions - (a[0].impressions + a[1].impressions) || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([key, m]) => [key, m[0].clicks, m[0].impressions, pos(m[0]), m[1].clicks, m[1].impressions, pos(m[1]), m[2].clicks, m[2].impressions]);
  const recentComplete = recent.length < cap;
  const complete = current.length < cap && previous.length < cap && recentComplete;
  const part = () => ({ ...window, complete, recentComplete, rows });
  while (rows.length && partBytes(part()) > limit) rows = rows.slice(0, Math.floor(rows.length * 0.9));
  return { part: part(), keys: merged.size, droppedKeys: merged.size - rows.length };
}

/**
 * Keep the part under `limit` bytes by dropping whole keys, the least clicked first (then the fewest impressions), so a
 * kept query or page keeps all its days and decay stays right. Returns the rows, how many keys and rows went and the
 * final size.
 */
export function truncatePart(rows, limit = MAX_PART_BYTES) {
  const size = (r) => Buffer.byteLength(JSON.stringify(r)) + 1;
  let bytes = 1 + rows.reduce((t, r) => t + size(r), 0);
  if (bytes <= limit) return { rows, bytes: partBytes(rows), keys: new Set(rows.map((r) => r[1])).size, droppedKeys: 0, droppedRows: 0 };
  const byKey = new Map();
  for (const r of rows) {
    const k = byKey.get(r[1]) ?? { key: r[1], clicks: 0, impressions: 0, bytes: 0, rows: 0 };
    k.clicks += r[2];
    k.impressions += r[3];
    k.bytes += size(r);
    k.rows += 1;
    byKey.set(r[1], k);
  }
  const ranked = [...byKey.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || (a.key < b.key ? -1 : 1));
  const keep = new Set();
  let used = 1;
  for (const k of ranked) {
    if (used + k.bytes > limit) break;
    used += k.bytes;
    keep.add(k.key);
  }
  const kept = rows.filter((r) => keep.has(r[1]));
  return { rows: kept, bytes: partBytes(kept), keys: keep.size, droppedKeys: byKey.size - keep.size, droppedRows: rows.length - kept.length };
}

// ---------- meta

/** Every field the SEO tab expects, empty (docs/SEO.md, "Parts"). */
export const emptyMeta = () => ({
  version: 1, project: '', name: '', domain: '', status: null, generatedAt: '', property: null, gscThrough: null,
  portfolioFocus: false, focusWeekday: null, lane: null, plan: null, targets: [], work: [], aiPanel: null, serpCompetitors: null, backlinks: null,
});

/**
 * The meta to push. An existing `meta` keeps every field it has (targets, plan, work, aiPanel and the rest); only
 * `property`, `gscThrough` and `generatedAt` change. With no meta yet, the empty one is filled from the site's name
 * and domain so the tab leaves its empty state.
 */
export function mergeMeta(existing, { site, property, through, now = Date.now() }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : { ...emptyMeta(), project: slug(site?.name || site?.domain || site?.id), name: site?.name ?? '', domain: site?.domain ?? '' };
  return { ...base, version: base.version ?? 1, property, gscThrough: through ?? base.gscThrough ?? null, generatedAt: new Date(now).toISOString() };
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

// ---------- the deployment

export class Server {
  constructor(base, fetcher = fetch) {
    this.base = base.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.cookie = '';
    this.key = '';
  }

  /** A scoped key (fdk_...) with the seo:write scope instead of the admin login. */
  useKey(key) {
    this.key = key;
  }

  async login(password) {
    const res = await this.fetcher(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.role !== 'admin') throw new Error(`Login refused (${res.status}): ${body.error ?? 'use the admin password'}`);
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  }

  async call(method, p, json) {
    const res = await this.fetcher(`${this.base}${p}`, {
      method,
      headers: {
        ...(this.key ? { authorization: `Bearer ${this.key}` } : { cookie: this.cookie }),
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} answered ${res.status}: ${body.error ?? res.statusText}`);
    return body;
  }
}

// ---------- one site

/**
 * Pull a site's four parts from Search Console and build them. Pure but for the requests. The page and query pairs
 * cover the 28 days ending on the last day Search Console has, and the 28 before, whatever `days` is.
 */
export async function pull({ token, property, days, today, maxRows, fetcher, wait, limit = MAX_PART_BYTES }) {
  const range = dateRange(days, today);
  const q = (dimensions, r = range, max = maxRows) => queryAll({ token, property, ...r, dimensions, maxRows: max, fetcher, wait });
  const daily = dailyPart(await q(['date']));
  const queries = truncatePart(queriesPart(await q(['date', 'query'])), limit);
  const pages = truncatePart(pagesPart(await q(['date', 'page'])), limit);
  const through = daily.length ? daily[daily.length - 1][0] : null;
  const parts = { gsc_daily: daily, gsc_queries: queries.rows, gsc_pages: pages.rows };
  const cuts = { gsc_queries: queries, gsc_pages: pages };
  if (through) {
    const w = pageQueryWindow(through);
    const cur = await q(['page', 'query'], { startDate: w.from, endDate: w.to }, PAGE_QUERY_PULL);
    const prev = await q(['page', 'query'], { startDate: w.previousFrom, endDate: w.previousTo }, PAGE_QUERY_PULL);
    const pq = pageQueriesPart(cur, prev, w, { limit });
    parts.gsc_page_queries = pq.part;
    cuts.gsc_page_queries = pq;
    const tw = totalsWindow(through);
    for (const [name, dimension] of [['gsc_page_totals', 'page'], ['gsc_query_totals', 'query']]) {
      const one = (startDate) => q([dimension], { startDate, endDate: tw.to }, TOTALS_PULL);
      const pulls = { current: await one(tw.from), previous: await q([dimension], { startDate: tw.previousFrom, endDate: tw.previousTo }, TOTALS_PULL), recent: await one(tw.recentFrom) };
      const t = totalsPart(pulls, tw, { page: dimension === 'page', limit });
      parts[name] = t.part;
      cuts[name] = t;
    }
  }
  return { range, through, parts, cuts };
}

export function summary(site, property, result) {
  const { parts, cuts, range, through } = result;
  const lines = [`${site}  ${property}  requested ${range.startDate} to ${range.endDate}, through ${through ?? 'no data'}`];
  for (const [name, rows] of Object.entries(parts)) {
    const cut = cuts[name];
    if (name === 'gsc_page_totals' || name === 'gsc_query_totals') {
      lines.push(`  ${name.padEnd(12)} ${String(rows.rows.length).padStart(7)} rows  ${rows.from} to ${rows.to} and the ${PAGE_QUERY_DAYS} days before  ${(partBytes(rows) / 1024).toFixed(0)} KB`);
      if (cut.droppedKeys) lines.push(`  ${name} kept the ${rows.rows.length} most clicked of ${cut.keys} ${name === 'gsc_page_totals' ? 'pages' : 'queries'}.`);
      continue;
    }
    if (name === 'gsc_page_queries') {
      lines.push(`  ${name.padEnd(12)} ${String(rows.rows.length).padStart(7)} rows  ${rows.from} to ${rows.to} and the ${PAGE_QUERY_DAYS} days before  ${(partBytes(rows) / 1024).toFixed(0)} KB`);
      if (cut.droppedKeys) lines.push(`  ${name} kept the ${rows.rows.length} most clicked of ${cut.pairs} page and query pairs.`);
      continue;
    }
    const keys = name === 'gsc_daily' ? null : cut.keys;
    const days = new Set(rows.map((r) => r[0])).size;
    lines.push(`  ${name.padEnd(12)} ${String(rows.length).padStart(7)} rows  ${String(days).padStart(3)} days  ${keys === null ? '' : `${String(keys).padStart(6)} ${name === 'gsc_pages' ? 'pages' : 'queries'}  `}${(partBytes(rows) / 1024).toFixed(0)} KB`);
    if (cut?.droppedKeys) lines.push(`  ${name} kept ${cut.keys} of ${cut.keys + cut.droppedKeys} ${name === 'gsc_pages' ? 'pages' : 'queries'} to stay under ${Math.round(MAX_PART_BYTES / 1000)} KB, dropping the ${cut.droppedKeys} least clicked (${cut.droppedRows} rows).`);
  }
  return lines.join('\n');
}

/**
 * Pull one site and, unless `dryRun`, push what changed: a part identical to the stored one is skipped, and meta is
 * pushed only when a part, the property or `gscThrough` moved. A second run on the same day writes nothing. Meta goes
 * last, so `gscThrough` only moves after the data landed.
 */
export async function syncSite(job, { creds, token, server, dryRun, today, maxRows, fetcher, wait, log = console.log, now = Date.now() }) {
  const property = normalizeProperty(job.property);
  const result = await pull({ token, property, days: job.days, today, maxRows, fetcher, wait });
  log(summary(job.site, property, result));
  if (!result.parts.gsc_daily.length) {
    log(`  Search Console returned no rows for ${property} in that range. Nothing pushed, so the last snapshot stays.`);
    return { ok: false, result, pushed: [] };
  }
  if (dryRun) return { ok: true, result, pushed: [] };
  const id = encodeURIComponent(job.site);
  const parts = (await server.call('GET', `/api/sites/${id}/seo`)).parts ?? {};
  const info = parts.meta ? null : await server.call('GET', `/api/sites/${id}`).catch(() => null);
  const pushed = [];
  for (const name of ['gsc_daily', 'gsc_queries', 'gsc_pages', 'gsc_page_queries', 'gsc_page_totals', 'gsc_query_totals']) {
    if (!result.parts[name]) continue;
    if (JSON.stringify(parts[name] ?? null) === JSON.stringify(result.parts[name])) continue;
    await server.call('PUT', `/api/sites/${id}/seo/${name}`, result.parts[name]);
    pushed.push(name);
  }
  const meta = mergeMeta(parts.meta, { site: info, property, through: result.through, now });
  const metaMoved = !parts.meta || parts.meta.property !== meta.property || parts.meta.gscThrough !== meta.gscThrough;
  if (pushed.length || metaMoved) {
    await server.call('PUT', `/api/sites/${id}/seo/meta`, meta);
    pushed.push('meta');
  }
  log(pushed.length ? `  pushed to ${job.site}: ${pushed.join(', ')} (gscThrough ${result.through})` : `  ${job.site} is up to date through ${result.through}. Nothing pushed.`);
  return { ok: true, result, pushed };
}

// ---------- command line

const HELP = `Usage:
  node scripts/gsc-sync.mjs --url <url> --site <id> --property <property> [options]   sync one site
  node scripts/gsc-sync.mjs --config <file> [options]                                 sync every site in a config file

Options:
  --url <url>             your FounderData deployment (or FOUNDERDATA_URL, or "url" in the config file)
  --site <id>             the site id (from the dashboard's site settings)
  --property <property>   sc-domain:acme.example or https://acme.example/ (with the trailing slash)
  --config <file>         JSON: { "url": "...", "days": 90, "sites": [{ "site": "SITE_ID", "property": "sc-domain:acme.example" }] }
                          Default ~/.config/founderdata/gsc-sync.json when it exists and --site is not given.
                          With --site, only that entry runs.
  --days <n>              days to pull, 1 to ${MAX_DAYS} (default ${DEFAULT_DAYS}); Search Console is about ${LAG_DAYS} days late
  --credentials <file>    Google service account key, or an OAuth file (client_id, client_secret, refresh_token).
                          Default ~/.config/founderdata/gsc-credentials.json, or the GSC_CREDENTIALS variable.
                          OAuth also works from GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN.
  --password-file <file>  the FounderData admin password (default ~/.config/founderdata/admin-password,
                          or the FOUNDERDATA_PASSWORD variable). The site API key (rt_...) can't push a snapshot.
  --key-file <file>       a scoped key (fdk_...) with seo:write instead of the password (or the FOUNDERDATA_KEY
                          variable)
  --max-rows <n>          rows pulled per part before the size cut (default ${DEFAULT_MAX_ROWS})
  --dry-run               pull from Search Console, print rows, days and bytes per part, push nothing`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (['--dry-run', '--help'].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** The jobs to run: from the config file (and `--site` to pick one), or the single site on the command line. */
export function jobsFrom(a, config, env = process.env) {
  const days = a.days ?? config?.days;
  const url = a.url ?? a._[0] ?? config?.url ?? env.FOUNDERDATA_URL ?? null;
  let jobs;
  if (config?.sites?.length) {
    jobs = config.sites.map((s) => ({ site: s.site, property: s.property, days: s.days ?? days }));
    if (a.site) jobs = jobs.filter((j) => j.site === a.site);
    if (a.property && a.site) jobs = [{ site: a.site, property: a.property, days }];
  } else if (a.site && a.property) {
    jobs = [{ site: a.site, property: a.property, days }];
  } else {
    jobs = [];
  }
  const bad = jobs.find((j) => !j.site || !j.property);
  if (bad) throw new Error('Every site needs "site" and "property".');
  return { url, jobs, credentials: a.credentials ?? config?.credentials ?? null };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    process.exit(0);
  }
  const defaultConfig = path.join(CONFIG_DIR, 'gsc-sync.json');
  const configFile = a.config ?? (!a.site && existsSync(defaultConfig) ? defaultConfig : null);
  let config = null;
  if (configFile) {
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (e) {
      console.error(`Can't read ${configFile}: ${e.message}`);
      process.exit(1);
    }
  }
  const { url, jobs, credentials } = jobsFrom(a, config);
  if (!jobs.length) {
    console.log(HELP);
    process.exit(1);
  }
  const dryRun = !!a['dry-run'];
  if (!url && !dryRun) {
    console.error('No deployment URL: pass --url, set FOUNDERDATA_URL or put "url" in the config file.');
    process.exit(1);
  }
  const creds = loadCredentials({ file: credentials });
  const token = await accessToken(creds);
  let server = null;
  if (!dryRun) {
    server = new Server(url);
    const key = process.env.FOUNDERDATA_KEY ?? (a['key-file'] ? readFileSync(a['key-file'], 'utf8').trim() : '');
    if (key) server.useKey(key);
    else {
      const file = a['password-file'] ?? path.join(CONFIG_DIR, 'admin-password');
      const password = process.env.FOUNDERDATA_PASSWORD ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
      if (!password) {
        console.error(`No admin password: set FOUNDERDATA_PASSWORD or put it in ${file}, or pass a key with --key-file.`);
        process.exit(1);
      }
      await server.login(password);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const maxRows = Number(a['max-rows']) > 0 ? Number(a['max-rows']) : undefined;
  let failed = 0;
  for (const job of jobs) {
    try {
      const r = await syncSite(job, { creds, token, server, dryRun, today, maxRows });
      if (!r.ok) failed++;
    } catch (e) {
      failed++;
      console.error(`${job.site}: ${e.message ?? e}`);
    }
  }
  if (dryRun) console.log('Dry run: nothing was pushed.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
