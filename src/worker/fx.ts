import type { Context, Next } from 'hono';
import type { AppEnv } from './env';
import { currencyDecimals } from './payments';
import { rawDb } from './lib/d1-trace';

/**
 * Payments in another currency than their site's (a USD Stripe checkout on a EUR site, an App Store purchase in
 * the buyer's currency) get amount_conv: the amount in the site's currency at the ECB reference rate of the
 * payment's day (UTC), from the Frankfurter API. Weekends and holidays use the last published rate. Until a
 * payment is converted (the rate API is down, or the ECB does not publish the currency) it stays out of the
 * revenue totals and shows in its own currency.
 */

const RATES_URL = 'https://api.frankfurter.dev/v1/';
const BATCH = 200;

type Rates = Map<string, number>;

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export async function ratesFor(db: D1Database, day: string, fetchFn: typeof fetch): Promise<Rates | null> {
  const stored = await db.prepare('SELECT currency, per_eur FROM fx_rates WHERE day = ?').bind(day).all<{ currency: string; per_eur: number }>();
  if (stored.results.length) return new Map(stored.results.map((r) => [r.currency, r.per_eur]));
  let body: { rates?: Record<string, number> };
  try {
    const res = await fetchFn(`${RATES_URL}${day}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const rates: Rates = new Map([['EUR', 1]]);
  for (const [cc, v] of Object.entries(body.rates ?? {})) if (/^[A-Z]{3}$/.test(cc) && v > 0) rates.set(cc, v);
  // Only past days are final; today's rate may still change, so it is used but not stored.
  if (day < dayOf(Date.now())) {
    await db.batch(
      [...rates].map(([cc, v]) => db.prepare('INSERT OR IGNORE INTO fx_rates (day, currency, per_eur) VALUES (?, ?, ?)').bind(day, cc, v)),
    );
  }
  return rates;
}

/** `amount` (minor units of `from`) in minor units of `to`, or null when a rate is missing. */
export function convert(amount: number, from: string, to: string, rates: Rates): number | null {
  const a = rates.get(from);
  const b = rates.get(to);
  if (!a || !b) return null;
  const major = amount / 10 ** currencyDecimals(from);
  return Math.round((major / a) * b * 10 ** currencyDecimals(to));
}

let running: Promise<number> | null = null;

/**
 * The newest payment row (rowid and id) this isolate has looked at with nothing left to convert. A pass from a read
 * route reads only the payments after it, so a read in a warm isolate scans the payments recorded since, not every
 * payment; the first pass of an isolate scans them all, as before. The mark holds while its row is still there: rowids
 * only grow past an existing row, so a deleted mark (its id gone) sends the pass back to a full scan. A pass from a
 * write path (a webhook, a corrected amount) always scans everything, and so does any pass while a row waits for a rate.
 */
const scanned = new WeakMap<D1Database, { rid: number; id: string }>();

/**
 * Convert every payment that is not in its site's currency yet. Returns how many were converted. `reads`: a read
 * route's pass, which may start at the mark above. `rescan`: a write just cleared the conversion of an existing row
 * (a corrected amount or refund), so the mark is dropped.
 */
export function convertPayments(db: D1Database, fetchFn: typeof fetch = fetch, opts: { reads?: boolean; rescan?: boolean } = {}): Promise<number> {
  if (opts.rescan) {
    scanned.delete(rawDb(db));
    // A pass already under way may have read before the write: run another after it.
    if (running) return running.then(() => convertPayments(db, fetchFn));
  }
  // Dashboard requests arrive in parallel; one pass at a time per isolate is enough.
  running ??= run(db, fetchFn, !!opts.reads).finally(() => (running = null));
  return running;
}

type Pending = { rid: number | null; site_id: string; id: string; ts: number; amount: number; currency: string; to_currency: string };
type Scan = Pending & { top: number | null; top_id: string | null; at_mark: string | null };

const scan = (db: D1Database, after: number, markRid: number) =>
  db
    .prepare(
      // One statement: the newest row and its id, the id at the mark, and the rows after the mark to convert (none:
      // one row of nulls beside the rest).
      `SELECT t.top, (SELECT id FROM payments WHERE rowid = t.top) AS top_id, (SELECT id FROM payments WHERE rowid = ?2) AS at_mark, q.*
       FROM (SELECT MAX(rowid) AS top FROM payments) t LEFT JOIN (
         SELECT p.rowid AS rid, p.site_id, p.id, p.ts, p.amount, p.currency, st.currency AS to_currency
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE p.rowid > ?1 AND p.amount_conv IS NULL AND p.currency != st.currency ORDER BY p.rowid LIMIT ${BATCH}
       ) q ON 1 = 1`,
    )
    .bind(after, markRid)
    .all<Scan>();

async function run(db: D1Database, fetchFn: typeof fetch, reads: boolean): Promise<number> {
  const key = rawDb(db);
  const mark = reads ? scanned.get(key) : undefined;
  let res = await scan(db, mark?.rid ?? 0, mark?.rid ?? 0);
  // The marked row is gone, so a new payment may sit at or below the mark: scan everything.
  if (mark && res.results[0]?.at_mark !== mark.id) res = await scan(db, 0, 0);
  const head = res.results[0];
  const rows = res.results.filter((r) => r.rid !== null);
  const done = () => {
    if (head?.top != null && head.top_id != null) scanned.set(key, { rid: Number(head.top), id: head.top_id });
    else scanned.delete(key);
  };
  if (!rows.length) {
    done();
    return 0;
  }
  // Each day's rates, read together (one round trip on a batching binding), not one day after another.
  const days = [...new Set(rows.map((r) => dayOf(r.ts)))];
  const rateList = await Promise.all(days.map((d) => ratesFor(db, d, fetchFn)));
  const byDay = new Map(days.map((d, i) => [d, rateList[i]]));
  const updates: D1PreparedStatement[] = [];
  for (const r of rows) {
    const rates = byDay.get(dayOf(r.ts));
    const v = rates ? convert(r.amount, r.currency, r.to_currency, rates) : null;
    if (v === null) continue;
    updates.push(db.prepare('UPDATE payments SET amount_conv = ? WHERE site_id = ? AND id = ?').bind(v, r.site_id, r.id));
  }
  if (updates.length) await db.batch(updates);
  // Everything up to the newest row is converted unless a row waits for a rate or the page was full: then no mark,
  // and the next pass scans everything again.
  if (updates.length === rows.length && rows.length < BATCH) done();
  else scanned.delete(key);
  return updates.length;
}

/** After a site's currency changed: drop its conversions and convert again into the new currency. */
export async function reconvertSite(db: D1Database, siteId: string, fetchFn: typeof fetch = fetch) {
  await db.prepare('UPDATE payments SET amount_conv = NULL WHERE site_id = ?').bind(siteId).run();
  await convertPayments(db, fetchFn, { rescan: true });
}

/** A payment's amount for totals that stay per currency: converted when it has been, else its own amount. */
export const PAY_AMOUNT = `COALESCE(p.amount_conv, p.amount)`;
/** The currency PAY_AMOUNT is in. Binds the site's currency (or pass a column with payCurrency). */
export const payCurrency = (siteCurrency = '?') => `(CASE WHEN p.amount_conv IS NOT NULL THEN ${siteCurrency} ELSE p.currency END)`;

// ---------- amounts over a range of days, each at its day's rate

const DAY_MS = 86_400_000;
const shiftDay = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
/** The ECB skips weekends and holidays; Easter (Thursday to Monday) is the longest stretch without a rate. */
const MAX_GAP_DAYS = 4;
/** Rows per INSERT: D1 binds at most 100 parameters per statement. */
const INSERT_ROWS = 33;
/** Ranges this isolate already filled per database, so a lasting gap costs one request per isolate, not one per call. */
const asked = new WeakMap<D1Database, Set<string>>();

/** Units per EUR for a currency on a day, or null when the ECB has no rate for it. */
export type RateLookup = (currency: string, day: string) => number | null;

/**
 * Rates for `currencies` over the days `from` to `to` (YYYY-MM-DD), from `fx_rates`. When a past day in the range has
 * no stored rate within MAX_GAP_DAYS before it, one call to the rate API's time series fills the whole range and stores
 * it, so a quarter costs one request the first time and none after. A day uses the newest rate on or before it, else
 * the oldest one after it (today, before the ECB publishes). A currency the ECB does not publish stays null.
 */
export async function rateLookup(
  db: D1Database,
  currencies: Iterable<string>,
  from: string,
  to: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
  opts: { fill?: boolean } = {},
): Promise<RateLookup & { gap?: boolean }> {
  const list = [...new Set(currencies)].filter((cc) => cc !== 'EUR' && /^[A-Z]{3}$/.test(cc));
  const known = new Map<string, [string, number][]>();
  // With fill false: read only, and report in `gap` that a lookup with fill would have called the rate API.
  let gap = false;
  if (list.length) {
    const start = shiftDay(from, -14);
    // One statement. The EUR row of a day marks it as fetched (migrations/0008_fx.sql).
    const read = async () => {
      const rows = await db
        .prepare(`SELECT day, currency, per_eur FROM fx_rates WHERE day >= ? AND day <= ? AND currency IN ('EUR', ${list.map(() => '?').join(', ')}) ORDER BY day`)
        .bind(start, to, ...list)
        .all<{ day: string; currency: string; per_eur: number }>();
      known.clear();
      const days: string[] = [];
      for (const r of rows.results) {
        if (r.currency === 'EUR') days.push(r.day);
        else {
          if (!known.has(r.currency)) known.set(r.currency, []);
          known.get(r.currency)!.push([r.day, r.per_eur]);
        }
      }
      return days;
    };
    const stored = await read();
    const last = [to, shiftDay(dayOf(now), -1)].sort()[0];
    if (from <= last && hasGap(stored, from, last)) {
      const span = `${shiftDay(from, -7)}..${last}`;
      const done = asked.get(rawDb(db)) ?? new Set<string>();
      asked.set(rawDb(db), done);
      if (opts.fill === false) gap = !done.has(span);
      // A failed call is tried again on the next read; a filled range with a lasting hole is not.
      else if (!done.has(span) && (await storeSeries(db, span, fetchFn, now))) {
        done.add(span);
        await read();
      }
    }
  }
  const lookup: RateLookup & { gap?: boolean } = (cc, day) => {
    if (cc === 'EUR') return 1;
    const rows = known.get(cc);
    if (!rows?.length) return null;
    let pick = rows[0][1];
    for (const [d, rate] of rows) {
      if (d > day) break;
      pick = rate;
    }
    return pick;
  };
  lookup.gap = gap;
  return lookup;
}

/**
 * The lookup rateLookup would give for `needed`, from one read ahead for a wider set (`wide`, read with fill false over
 * the same days): the same rates for the needed currencies and null for the rest. When the wide read found days the rate
 * API would fill, this does what rateLookup does, filling them.
 */
export async function narrowRates(
  db: D1Database,
  wide: RateLookup & { gap?: boolean },
  wideSet: Iterable<string>,
  needed: Iterable<string>,
  from: string,
  to: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<RateLookup> {
  const have = new Set(wideSet);
  const want = new Set([...needed].filter((cc) => cc !== 'EUR' && /^[A-Z]{3}$/.test(cc)));
  if (!want.size) return (cc) => (cc === 'EUR' ? 1 : null);
  if (wide.gap || [...want].some((cc) => !have.has(cc))) return rateLookup(db, want, from, to, fetchFn, now);
  return (cc, day) => (cc === 'EUR' ? 1 : want.has(cc) ? wide(cc, day) : null);
}

/** Whether some day from `from` to `last` has no stored day within MAX_GAP_DAYS on or before it. `stored` is sorted. */
function hasGap(stored: string[], from: string, last: string): boolean {
  let i = 0;
  let prev: string | null = null;
  for (let d = from; d <= last; d = shiftDay(d, 1)) {
    while (i < stored.length && stored[i] <= d) prev = stored[i++];
    if (!prev || prev < shiftDay(d, -MAX_GAP_DAYS)) return true;
  }
  return false;
}

/** Fetch the rate API's time series `YYYY-MM-DD..YYYY-MM-DD` and store every past day. False when the API failed. */
async function storeSeries(db: D1Database, span: string, fetchFn: typeof fetch, now: number): Promise<boolean> {
  let body: { rates?: Record<string, Record<string, number>> };
  try {
    const res = await fetchFn(`${RATES_URL}${span}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    body = await res.json();
  } catch {
    return false;
  }
  const today = dayOf(now);
  const rows: [string, string, number][] = [];
  for (const [day, rates] of Object.entries(body.rates ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) continue;
    rows.push([day, 'EUR', 1]);
    for (const [cc, v] of Object.entries(rates)) if (/^[A-Z]{3}$/.test(cc) && v > 0) rows.push([day, cc, v]);
  }
  if (!rows.length) return false;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += INSERT_ROWS) {
    const part = rows.slice(i, i + INSERT_ROWS);
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO fx_rates (day, currency, per_eur) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`).bind(...part.flat()),
    );
  }
  await db.batch(stmts);
  return true;
}

/** `amount` (major units of `from`) in major units of `to` at the rates of `day`, or null when a rate is missing. */
export function convertMajor(amount: number, from: string, to: string, day: string, rates: RateLookup): number | null {
  if (from === to) return amount;
  const a = rates(from, day);
  const b = rates(to, day);
  return a && b ? (amount / a) * b : null;
}

// ---------- the newest rate, for amounts compared now

/** Units of a currency per EUR, or null when no rate is stored. */
export type PerEur = (currency: string) => number | null;

/** The newest stored rate of each currency, from one read of the last 14 days of fx_rates. */
export async function newestRates(db: D1Database, currencies: string[], now = Date.now()): Promise<PerEur> {
  const list = [...new Set(currencies)];
  const marks = list.map(() => '?').join(', ');
  const since = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  const rows = (
    await db
      .prepare(`SELECT currency, per_eur FROM fx_rates WHERE currency IN (${marks}) AND day >= ? ORDER BY day DESC`)
      .bind(...list, since)
      .all<{ currency: string; per_eur: number }>()
  ).results;
  const rates = new Map<string, number>([['EUR', 1]]);
  for (const r of rows) if (!rates.has(r.currency)) rates.set(r.currency, r.per_eur);
  return (cc) => rates.get(cc) ?? null;
}

/**
 * Middleware for revenue reads: convert what the webhooks have not (the rate API was down, an App Store purchase came
 * in through the app) before the read counts converted amounts.
 */
export const convertBefore = async (c: Context<AppEnv>, next: Next) => {
  if (c.req.method === 'GET') await convertPayments(c.env.DB, fetch, { reads: true }).catch(() => 0);
  await next();
};
