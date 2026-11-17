// Subscription history from ChartMogul activities and a RevenueCat transactions export -> one timeline per
// subscription. Pure code: the dashboard runs it in the browser and sends the timelines (pro/worker/sub-import.ts),
// so the Worker never loops over thousands of activities in one request.
//
// A timeline is a list of stretches. A stretch is an unbroken paying period: `points` are [ms, monthly price in minor
// units of `currency`] at its start and at each price change, `end` is when it stopped (null while it pays).
// A cancel followed by a return is two stretches, which become two rows.

import { currencyDecimals } from './currency';

export const DAY = 86_400_000;
/** Two periods of one RevenueCat subscription with less than this between them are one stretch. */
export const GAP_MS = 2 * DAY;

export interface Stretch {
  points: [number, number][];
  end: number | null;
  currency: string;
  product: string | null;
  /** Price per billing period, minor units of `currency`, at the last point. */
  amount: number | null;
  interval: 'day' | 'week' | 'month' | 'year' | null;
  count: number;
  /** False for a stretch that is only a free trial: no points. */
  paid: boolean;
  trialStart: number | null;
  trialEnd: number | null;
  /** End of the paid period (RevenueCat); the Worker's 30-day lapse rule ends a stretch that never renewed. */
  expires: number | null;
}

export interface ImportedSub {
  ext: string;
  customer: string | null;
  stretches: Stretch[];
}

/** Minor-unit digits of a currency: the same helper the rest of the Worker uses (src/shared/currency.ts). */
export const decimalsOf = (cur: string) => currencyDecimals(cur.toUpperCase());

/** The same normalisation as the live subscriptions (src/worker/subscriptions.ts monthlyAmount): a year is 12 months, a week 52/12. */
export function monthlyOf(amount: number, interval: 'day' | 'week' | 'month' | 'year', count = 1): number {
  const per = interval === 'year' ? 1 / 12 : interval === 'week' ? 52 / 12 : interval === 'day' ? 365 / 12 : 1;
  return Math.round((amount * per) / Math.max(1, count));
}

// ---------- ChartMogul

/**
 * One activity as the Worker stores it: [type, ms, subscription external id, plan, customer external id, currency,
 * MRR after in cents, MRR movement in cents].
 */
export type CmActivity = [string, number, string, string | null, string | null, string, number | null, number];

/**
 * Timelines from activities. ChartMogul: "Add up all previous movements and you get a subscription's current MRR", so
 * each activity's MRR after it is the price; a churn ends the stretch, a new business or reactivation starts one.
 * https://dev.chartmogul.com/reference/activities/list/ and https://dev.chartmogul.com/docs/destinations/calculated-data/mrr-movements/
 */
export function buildChartMogul(activities: CmActivity[]): ImportedSub[] {
  const by = new Map<string, CmActivity[]>();
  activities.forEach((a) => {
    const list = by.get(a[2]);
    if (list) list.push(a);
    else by.set(a[2], [a]);
  });
  const out: ImportedSub[] = [];
  for (const [ext, list] of [...by].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    // Stable: activities of one instant keep the order ChartMogul sent them in.
    const sorted = list.map((a, i) => ({ a, i })).sort((x, y) => x.a[1] - y.a[1] || x.i - y.i).map((x) => x.a);
    const stretches: Stretch[] = [];
    let cur: Stretch | null = null;
    let level = 0;
    let customer: string | null = null;
    for (const [type, t, , plan, cust, currency, after, move] of sorted) {
      customer = cust ?? customer;
      const mrr = after ?? level + move;
      if (type === 'churn') {
        if (cur) {
          cur.end = t;
          cur = null;
        }
        level = 0;
        continue;
      }
      // Only a churn ends a subscription. Another activity that leaves 0 MRR (a 100% discount) keeps the stretch at a
      // price of 0; a subscription that has no paid stretch yet and sits at 0 (a free plan) is not imported.
      if (mrr <= 0 && !cur) {
        level = 0;
        continue;
      }
      if (!cur) {
        cur = { points: [[t, mrr]], end: null, currency, product: plan, amount: mrr, interval: null, count: 1, paid: true, trialStart: null, trialEnd: null, expires: null };
        stretches.push(cur);
      } else {
        const last = cur.points[cur.points.length - 1];
        if (last[0] === t) last[1] = mrr;
        else if (last[1] !== mrr) cur.points.push([t, mrr]);
        cur.amount = mrr;
        cur.product = plan ?? cur.product;
      }
      level = mrr;
    }
    if (stretches.length) out.push({ ext, customer, stretches });
  }
  return out;
}

// ---------- RevenueCat

/** One transaction of the Scheduled Data Export (columns: https://www.revenuecat.com/docs/integrations/scheduled-data-exports/transactions.md). */
export interface RcTx {
  /** store_transaction_id: with renewal_number the key of one transaction across deliveries. */
  id: string;
  /** original_store_transaction_id, else store_transaction_id: the id the webhook and App Store rows use. */
  sub: string;
  user: string | null;
  store: string;
  product: string | null;
  duration: string | null;
  start: number;
  end: number;
  refundedAt: number | null;
  trial: boolean;
  /** purchase_price_in_usd: gross, before tax and commission, set for refunded transactions too. */
  gross: number;
  /** price_in_usd: after full and partial refunds. */
  net: number;
  currency: string | null;
  /** purchase_price_in_purchased_currency. */
  local: number | null;
  renewal: number;
  updated: number;
}

export interface RcParse {
  txs: RcTx[];
  /** Rows left out, by reason. */
  left: { sandbox: number; notSubscription: number; unreadable: number };
  rows: number;
}

/** CSV text to rows: quotes, doubled quotes, line breaks inside a field, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** RevenueCat writes UTC times as "2024-01-15 10:00:00" or ISO; epoch milliseconds are read too. */
export function parseTime(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const iso = s.replace(' ', 'T');
  const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + 'Z');
  return Number.isFinite(t) ? t : null;
}

const num = (v: string | undefined): number | null => {
  const s = (v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const truthy = (v: string | undefined) => /^(true|1|yes)$/i.test((v ?? '').trim());

/** Transactions from the export's rows (header first). Several rows of one transaction keep the latest updated_at. */
export function parseRevenueCat(rows: string[][]): RcParse {
  const res: RcParse = { txs: [], left: { sandbox: 0, notSubscription: 0, unreadable: 0 }, rows: 0 };
  if (!rows.length) return res;
  const head = rows[0].map((h) => h.trim());
  const at = (name: string) => head.indexOf(name);
  const need = ['store_transaction_id', 'start_time', 'end_time', 'purchase_price_in_usd'];
  const missing = need.filter((n) => at(n) < 0);
  if (missing.length) throw new Error(`This is not a RevenueCat transactions export: the column ${missing[0]} is missing.`);
  const col = Object.fromEntries(
    ['store_transaction_id', 'original_store_transaction_id', 'rc_original_app_user_id', 'store', 'product_identifier', 'product_duration', 'start_time', 'end_time', 'refunded_at', 'is_trial_period', 'is_sandbox', 'is_auto_renewable', 'price_in_usd', 'purchase_price_in_usd', 'purchased_currency', 'purchase_price_in_purchased_currency', 'renewal_number', 'updated_at'].map((n) => [n, at(n)]),
  );
  const get = (r: string[], n: string) => (col[n] >= 0 ? r[col[n]] : undefined);
  const latest = new Map<string, RcTx>();
  for (const r of rows.slice(1)) {
    res.rows++;
    if (truthy(get(r, 'is_sandbox'))) {
      res.left.sandbox++;
      continue;
    }
    const auto = (get(r, 'is_auto_renewable') ?? '').trim();
    if (auto !== '' && !truthy(auto)) {
      res.left.notSubscription++;
      continue;
    }
    const id = (get(r, 'store_transaction_id') ?? '').trim();
    const start = parseTime(get(r, 'start_time'));
    const end = parseTime(get(r, 'end_time'));
    const gross = num(get(r, 'purchase_price_in_usd'));
    if (!id || start === null || end === null || end <= start || gross === null) {
      res.left.unreadable++;
      continue;
    }
    const tx: RcTx = {
      id,
      sub: (get(r, 'original_store_transaction_id') ?? '').trim() || id,
      user: (get(r, 'rc_original_app_user_id') ?? '').trim() || null,
      store: (get(r, 'store') ?? '').trim().toLowerCase(),
      product: (get(r, 'product_identifier') ?? '').trim() || null,
      duration: (get(r, 'product_duration') ?? '').trim() || null,
      start,
      end,
      refundedAt: parseTime(get(r, 'refunded_at')),
      trial: truthy(get(r, 'is_trial_period')),
      gross,
      net: num(get(r, 'price_in_usd')) ?? gross,
      currency: (get(r, 'purchased_currency') ?? '').trim().toUpperCase() || null,
      local: num(get(r, 'purchase_price_in_purchased_currency')),
      renewal: num(get(r, 'renewal_number')) ?? 0,
      updated: parseTime(get(r, 'updated_at')) ?? 0,
    };
    // The documented key of one transaction: store_transaction_id with renewal_number, the newest update wins.
    const key = `${id}|${tx.renewal}`;
    const prev = latest.get(key);
    if (!prev || tx.updated >= prev.updated) latest.set(key, tx);
  }
  res.txs = [...latest.values()];
  return res;
}

/**
 * Transactions of several deliveries as one list. A transaction that repeats keeps the row with the newest updated_at
 * (a refund arrives as a later row), whatever order the files come in; equal times go to the later file.
 */
export function mergeRevenueCatFiles(files: RcTx[][]): RcTx[] {
  const latest = new Map<string, RcTx>();
  for (const txs of files) {
    for (const t of txs) {
      const key = `${t.id}|${t.renewal}`;
      const prev = latest.get(key);
      if (!prev || t.updated >= prev.updated) latest.set(key, t);
    }
  }
  return [...latest.values()];
}

/** A period from an ISO 8601 duration (P1M, P1Y, P1W, P3M, P7D), else from its length. */
export function periodOf(duration: string | null, start: number, end: number): { interval: 'day' | 'week' | 'month' | 'year'; count: number } {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/i.exec(duration ?? '');
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    if (m[1] && !m[2]) return { interval: 'year', count: Number(m[1]) };
    if (m[2] || m[1]) return { interval: 'month', count: Number(m[2] ?? 0) + 12 * Number(m[1] ?? 0) };
    if (m[3]) return { interval: 'week', count: Number(m[3]) };
    const d = Number(m[4]);
    return d % 7 === 0 ? { interval: 'week', count: d / 7 } : { interval: 'day', count: d };
  }
  const days = (end - start) / DAY;
  if (days < 4) return { interval: 'day', count: Math.max(1, Math.round(days)) };
  if (days <= 24) return { interval: 'week', count: Math.max(1, Math.round(days / 7)) };
  if (days <= 45) return { interval: 'month', count: 1 };
  const months = Math.round(days / 30.44);
  return months < 12 ? { interval: 'month', count: months } : { interval: 'year', count: Math.max(1, Math.round(days / 365)) };
}

/**
 * Timelines from transactions. Each paid transaction covers [start_time, end_time). A fully refunded one covers only
 * until refunded_at; a partial refund keeps access. A free trial is a trial, a zero price outside a trial is a promo
 * and does not count (RevenueCat leaves promotional subscriptions out of MRR). Gross price: purchase_price_in_usd,
 * or the price in the buyer's currency when the site is not in USD, as the webhook counts it.
 */
export function buildRevenueCat(txs: RcTx[], opts: { siteCurrency: string; now: number }): ImportedSub[] {
  const by = new Map<string, RcTx[]>();
  for (const t of txs) {
    const l = by.get(t.sub);
    if (l) l.push(t);
    else by.set(t.sub, [t]);
  }
  const usd = opts.siteCurrency.toUpperCase() === 'USD';
  const out: ImportedSub[] = [];
  for (const [ext, list] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a.start - b.start || a.renewal - b.renewal);
    const user = list.find((t) => t.user)?.user ?? null;
    const apple = list.some((t) => t.store === 'app_store' || t.store === 'mac_app_store');
    const stretches: Stretch[] = [];
    let cur: Stretch | null = null;
    let lastEnd = 0;
    let trial: { start: number; end: number } | null = null;
    const close = () => {
      if (!cur) return;
      cur.expires = lastEnd;
      cur.end = lastEnd < opts.now ? lastEnd : null;
      cur = null;
    };
    for (const t of list) {
      if (t.trial && t.gross <= 0) {
        trial = trial ?? { start: t.start, end: t.end };
        continue;
      }
      if (t.gross <= 0) continue;
      const full = t.refundedAt !== null && t.net <= 0;
      const end = full ? Math.min(t.end, Math.max(t.start, t.refundedAt!)) : t.end;
      if (end <= t.start) continue;
      const cents = usd || t.local === null || !t.currency;
      const currency = cents ? 'USD' : t.currency!;
      const price = Math.round((cents ? t.gross : t.local!) * 10 ** decimalsOf(currency));
      const p = periodOf(t.duration, t.start, t.end);
      const monthly = monthlyOf(price, p.interval, p.count);
      if (cur && t.start - lastEnd <= GAP_MS && cur.currency === currency) {
        const last = cur.points[cur.points.length - 1];
        if (last[1] !== monthly) cur.points.push([t.start, monthly]);
      } else {
        close();
        cur = {
          points: [[t.start, monthly]], end: null, currency, product: t.product, amount: price, interval: p.interval, count: p.count, paid: true,
          trialStart: trial ? trial.start : null, trialEnd: trial ? trial.end : null, expires: null,
        };
        trial = null;
        stretches.push(cur);
      }
      cur.amount = price;
      cur.interval = p.interval;
      cur.count = p.count;
      cur.product = t.product ?? cur.product;
      lastEnd = Math.max(lastEnd, end);
      if (full) close();
    }
    close();
    if (trial) {
      stretches.push({ points: [], end: null, currency: opts.siteCurrency.toUpperCase(), product: list[0].product, amount: null, interval: null, count: 1, paid: false, trialStart: trial.start, trialEnd: trial.end, expires: trial.end });
    }
    if (stretches.length) out.push({ ext, customer: apple ? `apple:${ext}` : user ? `rc:${user.slice(0, 128)}` : null, stretches });
  }
  return out;
}

/** Cut subscriptions into requests of at most `maxSubs` subscriptions and about `maxBytes` of JSON. */
export function chunkSubs(subs: ImportedSub[], maxSubs: number, maxBytes: number): ImportedSub[][] {
  const out: ImportedSub[][] = [];
  let cur: ImportedSub[] = [];
  let size = 0;
  for (const s of subs) {
    const bytes = JSON.stringify(s).length + 1;
    if (cur.length && (cur.length >= maxSubs || size + bytes > maxBytes * 0.9)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A pasted RevenueCat Charts CSV: month and MRR in major units. Reads the first date column and the column named MRR (else the second). */
export function parseMrrCsv(text: string): { month: string; value: number }[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  let vi = head.findIndex((h) => /mrr/.test(h));
  if (vi < 0) vi = head.length > 1 ? 1 : 0;
  const out = new Map<string, number>();
  for (const r of rows.slice(1)) {
    const t = parseTime(r[0]?.trim().length === 7 ? r[0].trim() + '-01' : (r[0] ?? '').replace(/^"|"$/g, ''));
    const v = Number((r[vi] ?? '').replace(/[^0-9.\-]/g, ''));
    if (t === null || !Number.isFinite(v) || r[vi] === undefined || r[vi].trim() === '') continue;
    // The last row of a month is its end.
    out.set(new Date(t).toISOString().slice(0, 7), v);
  }
  return [...out].map(([month, value]) => ({ month, value })).sort((a, b) => (a.month < b.month ? -1 : 1));
}
