#!/usr/bin/env node
// FounderData ASO collector (docs/ASO.md). Apple answers 403 to its App Store search, lookup and review feeds when
// the request comes from Cloudflare, so the Worker can't fetch them. Run this on another machine instead: your Mac,
// a home server or a VPS. It reads each app's keywords and countries from your deployment, asks Apple, and posts one
// snapshot per app and country back.
//
// It uses App Store endpoints that Apple doesn't document for this use, and Apple's terms don't allow automated
// access to them. You decide whether to run it. It keeps the volume low: one search per keyword and country a run,
// a few seconds between requests to the same host, and it stops asking a host for 6 hours after a 403 or 429.
//
//   node scripts/aso-collect.mjs https://founderdata.example.com        collect and post
//   node scripts/aso-collect.mjs --probe                                 check whether Apple answers this machine
//   node scripts/aso-collect.mjs --help
//
// No dependencies, Node 20 or later.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = 'aso-collect/1';
const USER_AGENT = `FounderData-${VERSION} (+https://github.com/founderdata/founderdata)`;
const TOP = 10;

/** App Store storefront ids. pro/worker/aso.ts keeps the same table; pro/test/aso.test.ts checks they match. */
export const STOREFRONTS = {
  us: '143441', fr: '143442', de: '143443', gb: '143444', at: '143445', be: '143446', fi: '143447', gr: '143448',
  ie: '143449', it: '143450', lu: '143451', nl: '143452', pt: '143453', es: '143454', ca: '143455', se: '143456',
  no: '143457', dk: '143458', ch: '143459', au: '143460', nz: '143461', jp: '143462', hk: '143463', sg: '143464',
  cn: '143465', kr: '143466', in: '143467', mx: '143468', ru: '143469', tw: '143470', vn: '143471', za: '143472',
  my: '143473', ph: '143474', th: '143475', id: '143476', pk: '143477', pl: '143478', sa: '143479', tr: '143480',
  ae: '143481', hu: '143482', cl: '143483', ro: '143487', cz: '143489', il: '143491', ua: '143492', co: '143501',
  br: '143503', ar: '143505', eg: '143516',
};

export const searchUrl = (term) =>
  `https://search.itunes.apple.com/WebObjects/MZStore.woa/wa/search?clientApplication=Software&media=software&term=${encodeURIComponent(term)}`;
export const hintsUrl = (term) => `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}`;
export const lookupUrl = (ids, country) => `https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${country}&entity=software`;
export const bundleLookupUrl = (bundleId, country) => `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${country}`;
export const reviewsUrl = (appId, country, page) => `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;

// ---------- parsing Apple's answers

const str = (v, max = 100) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const label = (v) => (v && typeof v === 'object' && typeof v.label === 'string' ? v.label : null);

/**
 * The search answer: the ranked app ids, the app's rank, each competitor's rank and the top 10 with what the answer
 * says about them (name, subtitle, rating count, average, release day). Apple includes full details for about the
 * first 8; `missing` lists the top-10 ids without them, for the lookup to fill in.
 */
export function parseSearch(body, { appId = null, competitors = [] } = {}) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const bubble = Array.isArray(json?.bubbles) ? json.bubbles.find((b) => Array.isArray(b?.results)) : null;
  if (!bubble) return { ok: false, error: 'no bubbles[].results in the answer' };
  const ids = [];
  for (const r of bubble.results) {
    const id = typeof r?.id === 'string' || typeof r?.id === 'number' ? String(r.id) : null;
    if (id && /^\d+$/.test(id) && (!r.entity || r.entity === 'software') && !ids.includes(id)) ids.push(id);
  }
  const lockups = json?.storePlatformData?.['native-search-lockup-search']?.results ?? {};
  const top = ids.slice(0, TOP).map((id) => {
    const l = lockups[id];
    if (!l) return [id, null, null, null, null, null];
    const released = typeof l.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(l.releaseDate) ? l.releaseDate.slice(0, 10) : null;
    return [id, str(l.name), str(l.subtitle), Number.isInteger(l.userRating?.ratingCount) ? l.userRating.ratingCount : null, typeof l.userRating?.value === 'number' ? l.userRating.value : null, released];
  });
  const rankOf = (id) => {
    const i = ids.indexOf(String(id));
    return i < 0 ? null : i + 1;
  };
  return {
    ok: true,
    results: ids.length,
    rank: appId ? rankOf(appId) : null,
    competitors: Object.fromEntries(competitors.map((c) => [c, rankOf(c)])),
    top,
    missing: top.filter((t) => t[1] === null).map((t) => t[0]),
  };
}

/** The lookup answer, by app id: name, rating count, average rating, version and release day. */
export function parseLookup(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(json?.results)) return null;
  const out = new Map();
  for (const r of json.results) {
    if (!r?.trackId) continue;
    out.set(String(r.trackId), {
      name: str(r.trackName),
      bundleId: str(r.bundleId, 155),
      count: Number.isInteger(r.userRatingCount) ? r.userRatingCount : 0,
      average: typeof r.averageUserRating === 'number' ? Math.round(r.averageUserRating * 100) / 100 : null,
      version: str(r.version, 30),
      released: typeof r.releaseDate === 'string' ? r.releaseDate.slice(0, 10) : null,
    });
  }
  return out;
}

/** The reviews of one RSS page, newest first. Older feeds put the app itself first; it has no rating and is skipped. */
export function parseReviews(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const feed = json?.feed;
  if (!feed || typeof feed !== 'object') return null;
  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  const out = [];
  for (const e of entries) {
    const rating = Number(label(e?.['im:rating']));
    const id = label(e?.id);
    const at = Date.parse(label(e?.updated) ?? '');
    if (!id || !/^\d+$/.test(id) || !(rating >= 1 && rating <= 5) || !Number.isFinite(at)) continue;
    out.push({ id, at, rating, title: str(label(e.title), 200), body: str(label(e.content), 6000), author: str(label(e.author?.name), 100), version: str(label(e['im:version']), 30) });
  }
  return out;
}

/** The terms of the search hints answer, a plist. */
export function parseHints(xml) {
  const out = [];
  const re = /<key>term<\/key>\s*<string>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  return out;
}

// ---------- talking to Apple, politely

const STATE_FILE = path.join(homedir(), '.config', 'founderdata', 'aso-collector.json');
const PAUSE_MS = 6 * 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One client per run. Requests to the same host are at least `gapMs` apart, and a run makes at most `maxRequests`.
 * A 429 with a short Retry-After is retried once after it. Any other 429, or a 403, stops that host for the rest of
 * the run and, with `state`, for 6 hours.
 */
export class Apple {
  constructor({ gapMs = 3000, maxRequests = 300, fetcher = fetch, state = null, now = () => Date.now(), wait = sleep } = {}) {
    Object.assign(this, { gapMs, maxRequests, fetcher, state, now, wait });
    this.used = 0;
    this.last = new Map();
    this.blocked = new Map();
  }

  /** Why `host` is off for now, or null. */
  off(host) {
    if (this.blocked.has(host)) return this.blocked.get(host);
    const p = this.state?.hosts?.[host];
    if (p && p.until > this.now()) return { status: p.status, retryAfter: null, paused: true };
    return null;
  }

  async get(url, headers = {}) {
    const host = new URL(url).host;
    const off = this.off(host);
    if (off) return { status: null, skipped: true, ...off };
    if (this.used >= this.maxRequests) return { status: null, skipped: true, budget: true };
    for (let attempt = 0; ; attempt++) {
      const since = this.now() - (this.last.get(host) ?? 0);
      if (since < this.gapMs) await this.wait(this.gapMs - since);
      this.used++;
      this.last.set(host, this.now());
      let res;
      const started = this.now();
      try {
        res = await this.fetcher(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/xml', ...headers } });
      } catch (e) {
        return { status: 0, error: e?.message ?? String(e) };
      }
      const body = await res.text().catch(() => '');
      const ms = this.now() - started;
      if (res.status !== 403 && res.status !== 429) return { status: res.status, body, ms };
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      if (res.status === 429 && attempt === 0 && retryAfter && retryAfter <= 60) {
        await this.wait(retryAfter * 1000);
        continue;
      }
      const why = { status: res.status, retryAfter, paused: false };
      this.blocked.set(host, why);
      if (this.state) (this.state.hosts ??= {})[host] = { until: this.now() + Math.max(PAUSE_MS, (retryAfter ?? 0) * 1000), status: res.status };
      return { ...why, body, ms };
    }
  }
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { hosts: {} };
  }
}

function writeState(file, state) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`Could not save ${file}: ${e.message}`);
  }
}

// ---------- one app in one country

const source = () => ({ ok: 0, failed: 0, skipped: 0, status: null, retryAfter: null, paused: false });

function count(src, r) {
  if (r.skipped) {
    src.skipped++;
    if (r.paused) src.paused = true;
  } else if (r.status === 200) src.ok++;
  else src.failed++;
  if (r.status) src.status = r.status;
  if (r.retryAfter) src.retryAfter = r.retryAfter;
}

/**
 * New reviews of the app in one country, newest first, until one FounderData already has or `reviewPages` pages
 * (Apple serves 10 of 50). `src` collects the request counts for the snapshot's `sources`.
 */
export async function collectReviews(apple, site, country, appId, src = source(), reviewPages = 10) {
  const reviews = [];
  if (!appId) return reviews;
  const newest = site.newestReview?.[country] ?? null;
  const pages = Math.max(1, Math.min(10, reviewPages ?? 10));
  for (let page = 1; page <= pages; page++) {
    const r = await apple.get(reviewsUrl(appId, country, page));
    count(src, r);
    if (r.status !== 200) break;
    const list = parseReviews(r.body);
    if (!list) {
      src.ok--;
      src.failed++;
      break;
    }
    const fresh = newest ? list.filter((x) => x.at > newest) : list;
    reviews.push(...fresh);
    if (list.length < 50 || fresh.length < list.length) break;
  }
  return reviews;
}

/**
 * Check every keyword of `site` in `country`, then one lookup for ratings (the app, its competitors and top-10 apps
 * the search answer had no details for), then new reviews. Returns the snapshot and the reviews to post.
 */
export async function collectCountry(apple, site, country, appId, opts = {}) {
  const storefront = STOREFRONTS[country];
  const sources = { search: source(), lookup: source(), reviews: source() };
  const keywords = [];
  for (const keyword of opts.keywords ?? site.keywords) {
    const r = await apple.get(searchUrl(keyword), { 'X-Apple-Store-Front': `${storefront},24 t:native` });
    count(sources.search, r);
    if (r.status !== 200) continue;
    const parsed = parseSearch(r.body, { appId, competitors: site.competitors });
    if (!parsed.ok) {
      sources.search.ok--;
      sources.search.failed++;
      sources.search.status = 200;
      continue;
    }
    opts.onChecked?.(keyword);
    keywords.push({ keyword, rank: parsed.rank, results: parsed.results, competitors: parsed.competitors, top: parsed.top, missing: parsed.missing });
  }

  // One lookup: the app, its competitors and the top-10 apps without details, in chunks of 100 ids.
  const ids = [...new Set([appId, ...site.competitors, ...keywords.flatMap((k) => k.missing)].filter(Boolean))];
  const info = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await apple.get(lookupUrl(ids.slice(i, i + 100), country));
    count(sources.lookup, r);
    const parsed = r.status === 200 ? parseLookup(r.body) : null;
    if (r.status === 200 && !parsed) {
      sources.lookup.ok--;
      sources.lookup.failed++;
    }
    for (const [id, v] of parsed ?? []) info.set(id, v);
  }
  for (const k of keywords) {
    k.top = k.top.map((t) => {
      const v = t[1] === null ? info.get(t[0]) : null;
      return v ? [t[0], v.name, null, v.count, v.average, v.released] : t;
    });
    delete k.missing;
  }
  const ratings = [appId, ...site.competitors].filter((id) => id && info.has(id)).map((id) => {
    const v = info.get(id);
    return [id, v.name, v.count, v.average, v.version];
  });

  // Reviews, newest first, until one FounderData has or `reviewPages` pages (Apple serves 10 of 50).
  const reviews = opts.reviews === false ? [] : await collectReviews(apple, site, country, appId, sources.reviews, opts.reviewPages);

  return {
    snapshot: { v: 1, country, collectedAt: Date.now(), appId, keywords, ratings, sources, collector: VERSION },
    reviews,
  };
}

// ---------- the deployment

export class Server {
  constructor(base, fetcher = fetch) {
    this.base = base.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.cookie = '';
    this.key = '';
  }

  /** A scoped key (fdk_...) with the aso:write scope instead of the admin login. */
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

/** The app's App Store id: the one the deployment knows, else Apple's lookup by bundle id. */
async function appIdFor(apple, site, country) {
  if (site.appId) return site.appId;
  const r = await apple.get(bundleLookupUrl(site.bundleId, country));
  if (r.status !== 200) return null;
  const found = parseLookup(r.body);
  const hit = [...(found ?? [])].find(([, v]) => v.bundleId === site.bundleId);
  return hit ? hit[0] : null;
}

/** Snapshots go up in chunks of this many keywords, about 70 KB each, under the Worker's 256 KB limit. */
export const CHUNK = 50;
/** Requests kept back per app and country for the lookup and the first review page. */
const RESERVE = 3;
const DAY_MS = 86_400_000;

/**
 * Which keywords to check in which country this run. A run makes at most `budget` searches, so an app with more
 * keyword and country pairs than that is checked over several runs: the pairs checked longest ago go first, and a
 * pair never checked goes before all. `checked` maps "site|country|keyword" to the time of its last check. Without
 * it (a runner that starts fresh each time) the list rotates by the day, so each run picks up where the last stopped.
 */
export function planSearches(sites, budget, checked = null, now = Date.now()) {
  const pairs = [];
  for (const site of sites) {
    for (const { code } of site.countries) {
      for (const keyword of site.keywords) pairs.push({ site: site.id, country: code, keyword, at: checked?.[`${site.id}|${code}|${keyword}`] ?? 0 });
    }
  }
  let ordered = pairs;
  if (checked) ordered = [...pairs].sort((x, y) => x.at - y.at);
  else if (pairs.length > budget) {
    const offset = (Math.floor(now / DAY_MS) * Math.max(1, budget)) % pairs.length;
    ordered = [...pairs.slice(offset), ...pairs.slice(0, offset)];
  }
  const plan = new Map();
  for (const p of ordered.slice(0, Math.max(0, budget))) {
    const key = `${p.site}|${p.country}`;
    if (!plan.has(key)) plan.set(key, new Set());
    plan.get(key).add(p.keyword);
  }
  return { plan, total: pairs.length, chosen: Math.min(pairs.length, Math.max(0, budget)) };
}

export async function collect(server, apple, { only = null, dryRun = false, log = console.log, reviewPages, reviewsOnly = false } = {}) {
  const config = await server.call('GET', '/api/aso/collect');
  const sites = config.sites.filter((s) => !only || s.id === only);
  if (!sites.length) {
    log(only ? `Site ${only} has no ASO keywords.` : 'No app has ASO keywords yet. Add them in the ASO tab.');
    return [];
  }
  const state = apple.state ?? null;
  const checked = state ? (state.checked ??= {}) : null;
  if (checked && !only) {
    // Forget keywords and countries that are gone, so the file doesn't grow.
    const live = new Set(sites.flatMap((s) => s.countries.flatMap((c) => s.keywords.map((k) => `${s.id}|${c.code}|${k}`))));
    for (const key of Object.keys(checked)) if (!live.has(key)) delete checked[key];
  }
  const countryRuns = sites.reduce((n, s) => n + s.countries.length, 0);
  const { plan, total, chosen } = reviewsOnly ? { plan: new Map(), total: 0, chosen: 0 } : planSearches(sites, apple.maxRequests - countryRuns * RESERVE, checked);
  const rows = [];
  for (const site of sites) {
    let appId = null;
    for (const { code } of site.countries) {
      appId ??= await appIdFor(apple, site, code);
      let snapshot = null;
      let reviews;
      if (reviewsOnly) {
        reviews = await collectReviews(apple, site, code, appId, source(), reviewPages);
      } else {
        const keywords = site.keywords.filter((k) => plan.get(`${site.id}|${code}`)?.has(k));
        ({ snapshot, reviews } = await collectCountry(apple, site, code, appId, {
          reviewPages,
          keywords,
          onChecked: (k) => {
            if (checked && !dryRun) checked[`${site.id}|${code}|${k}`] = Date.now();
          },
        }));
      }
      let posted = 'dry run';
      let added = 0;
      if (!dryRun) {
        try {
          if (snapshot) {
            // Chunks of 50 keywords merge into one row for the day. Each carries the ratings and sources.
            for (let i = 0; i === 0 || i < snapshot.keywords.length; i += CHUNK) {
              await server.call('POST', `/api/sites/${site.id}/aso/snapshot`, { ...snapshot, keywords: snapshot.keywords.slice(i, i + CHUNK) });
            }
          }
          for (let i = 0; i < reviews.length; i += 100) {
            added += (await server.call('POST', `/api/sites/${site.id}/aso/reviews`, { country: code, reviews: reviews.slice(i, i + 100) })).added ?? 0;
          }
          posted = 'posted';
        } catch (e) {
          posted = `not posted: ${e.message}`;
        }
      }
      const reviewCell = dryRun ? String(reviews.length) : `${added} new`;
      if (!snapshot) {
        rows.push([site.name, code, '-', '-', '-', reviewCell, 'reviews only', posted]);
        continue;
      }
      const ranked = snapshot.keywords.filter((k) => k.rank !== null).length;
      rows.push([site.name, code, `${snapshot.keywords.length}/${site.keywords.length}`, String(ranked), String(snapshot.ratings.length), reviewCell, statusText(snapshot.sources), posted]);
    }
  }
  log(table(['App', 'Country', 'Checked', 'Ranked', 'Ratings', 'Reviews', 'Apple', 'Snapshot'], rows));
  if (!reviewsOnly && chosen < total) {
    log(`${chosen} of ${total} keyword and country pairs checked this run, the ones checked longest ago first. The rest follow in the next runs.`);
  }
  log(`${apple.used} requests to Apple.`);
  return rows;
}

const statusText = (s) =>
  Object.entries(s)
    .map(([name, v]) => (v.failed || v.skipped ? `${name} ${v.status ?? '-'}${v.paused ? ' paused' : ''}${v.skipped ? `, ${v.skipped} skipped` : ''}` : `${name} ok`))
    .join('; ');

export function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

// ---------- the probe

/**
 * Does Apple answer this machine? One search per country, the hints, one lookup and one review page, 3 seconds apart.
 * Prints a table and returns true when search, lookup and reviews all answered 200 with data.
 */
export async function probe(apple, { countries = ['us', 'de'], term = 'habit tracker', log = console.log } = {}) {
  const rows = [];
  let first = null;
  let good = true;
  const row = (what, cc, r, n) => {
    rows.push([what, cc, r.skipped ? 'skipped' : String(r.status), n === null ? '-' : String(n), r.body ? `${Math.round(r.body.length / 1024)} KB` : '-', r.ms === undefined ? '-' : `${r.ms} ms`]);
  };
  for (const cc of countries) {
    const s = await apple.get(searchUrl(term), { 'X-Apple-Store-Front': `${STOREFRONTS[cc]},24 t:native` });
    const parsed = s.status === 200 ? parseSearch(s.body) : null;
    row('search', cc, s, parsed?.ok ? parsed.results : null);
    good &&= !!parsed?.ok && parsed.results > 0;
    first ??= parsed?.ok ? parsed.top[0]?.[0] : null;
    const h = await apple.get(hintsUrl(term.split(' ')[0]), { 'X-Apple-Store-Front': `${STOREFRONTS[cc]}-1,29` });
    row('hints', cc, h, h.status === 200 ? parseHints(h.body).length : null);
    const id = first ?? '284882215';
    const l = await apple.get(lookupUrl([id], cc));
    const info = l.status === 200 ? parseLookup(l.body) : null;
    row('lookup', cc, l, info ? info.size : null);
    good &&= !!info?.size;
    const r = await apple.get(reviewsUrl(id, cc, 1));
    const list = r.status === 200 ? parseReviews(r.body) : null;
    row('reviews', cc, r, list ? list.length : null);
    good &&= !!list;
  }
  log(table(['Endpoint', 'Country', 'Status', 'Results', 'Size', 'Time'], rows));
  log(good ? 'Apple answers this machine. You can schedule the collector here.' : 'Apple did not answer every request. Ranks, ratings or reviews would be missing from this machine.');
  return good;
}

// ---------- command line

const HELP = `Usage:
  node scripts/aso-collect.mjs <url> [options]    collect ranks, ratings and reviews and post them
  node scripts/aso-collect.mjs --probe [options]  check whether Apple answers this machine, post nothing

Options:
  --password-file <file>  the admin password (default ~/.config/founderdata/admin-password,
                          or the FOUNDERDATA_PASSWORD variable)
  --key-file <file>       a scoped key (fdk_...) with aso:write instead of the password (or the
                          FOUNDERDATA_KEY variable); it collects the sites the key covers
  --site <id>             only this site
  --dry-run               ask Apple, print the table, post nothing
  --gap <seconds>         seconds between two requests to the same Apple host (default 3, at least 1)
  --max-requests <n>      requests to Apple per run (default 300). An app with more keyword and country pairs
                          than that is checked over several runs, the longest unchecked first
  --reviews-only          only read new reviews, one request per app and country, and post them. Run it every
                          hour so a bad review alerts you within the hour. Checks no ranks
  --review-pages <n>      review pages of 50 per app and country, 1 to 10 (default 10; later runs stop at
                          the first review they already have)
  --ignore-pause          ask hosts that answered 403 or 429 in the last 6 hours anyway
  --country <cc,cc>       --probe only: countries to check (default us,de)
  --term <text>           --probe only: the search term (default "habit tracker")`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (['--probe', '--dry-run', '--ignore-pause', '--reviews-only', '--help'].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help || (!a.probe && !a._[0])) {
    console.log(HELP);
    process.exit(a.help ? 0 : 1);
  }
  const gapMs = Math.max(1, Number(a.gap) || 3) * 1000;
  const maxRequests = Math.max(1, Number(a['max-requests']) || 300);
  const state = readState(STATE_FILE);
  if (a['ignore-pause']) state.hosts = {};
  const apple = new Apple({ gapMs, maxRequests, state });
  if (a.probe) {
    const countries = String(a.country ?? 'us,de').toLowerCase().split(',').filter((c) => STOREFRONTS[c]);
    const good = await probe(apple, { countries: countries.length ? countries : ['us'], term: a.term ?? 'habit tracker' });
    process.exit(good ? 0 : 1);
  }
  const server = new Server(a._[0]);
  const key = process.env.FOUNDERDATA_KEY ?? (a['key-file'] ? readFileSync(a['key-file'], 'utf8').trim() : '');
  if (key) server.useKey(key);
  else {
    const file = a['password-file'] ?? path.join(homedir(), '.config', 'founderdata', 'admin-password');
    const password = process.env.FOUNDERDATA_PASSWORD ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    if (!password) {
      console.error(`No admin password: set FOUNDERDATA_PASSWORD or put it in ${file}, or pass a key with --key-file.`);
      process.exit(1);
    }
    await server.login(password);
  }
  await collect(server, apple, { only: a.site ?? null, dryRun: !!a['dry-run'], reviewPages: Number(a['review-pages']) || undefined, reviewsOnly: !!a['reviews-only'] });
  writeState(STATE_FILE, state);
  if (apple.blocked.size) {
    for (const [host, why] of apple.blocked) console.log(`${host} answered ${why.status}; the collector skips it for 6 hours.`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
