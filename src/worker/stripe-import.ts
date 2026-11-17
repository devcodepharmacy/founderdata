import type { Hono } from 'hono';
import type { AppEnv, Site } from './env';
import { handleStripeEvent } from './stripe';

/**
 * Stripe history import: the charges of the last N months, stored as Stripe payments (docs/GUIDE.md, "Import Stripe
 * history"). The dashboard starts it with a restricted key and then calls the step route until it is done:
 *
 *   GET    /api/sites/:id/stripe-import        progress
 *   POST   /api/sites/:id/stripe-import        { key: "rk_live_...", months: 12 } starts (or restarts) it
 *   POST   /api/sites/:id/stripe-import/step   one step: one page of charges from Stripe
 *   DELETE /api/sites/:id/stripe-import        cancels it and forgets the key
 *
 * Each step makes one Stripe API call and at most about 50 D1 queries (the free plan's limit per request), and stores
 * its cursor, so a failed step resumes where it was. The key stays in D1 only while the import runs: an import with no
 * step for 1 hour (the tab was closed) is "stopped" and its key deleted, by every cron run and by the next read of its
 * state. Posting the key again resumes a stopped import from its cursor.
 *
 * Every charge goes through the webhook code (stripe.ts handleStripeEvent) as the event Stripe would have sent: an
 * invoice charge as invoice.paid, a PaymentIntent charge as payment_intent.succeeded, an old Charges API charge as
 * charge.succeeded, and its refunds as charge.refunded. So an imported payment has the id a webhook gives it, and a
 * payment a webhook already stored, or another site holds, is never stored twice. Imported payments raise no alert.
 * There are no visits for them, so they link to a visitor only through the email of a visitor you identify()'d or an
 * earlier payment of the same customer; the rest count under "No source". Test mode charges and lost disputes are
 * not imported.
 */

/** Pinned so charges name their invoice and invoices their PaymentIntent, whatever the account's default version. */
export const STRIPE_IMPORT_VERSION = '2024-06-20';
/** Charges per Stripe call. The duplicate check binds 4 values per charge; D1 takes 100. */
const PAGE = 20;
/** Start no new charge past this many D1 queries in a step: a charge with a refund takes up to about 20. */
const QUERY_BUDGET = 30;
export const MAX_MONTHS = 36;
const MONTH_MS = 30.44 * 86_400_000;
/** A running import with no step for this long is stopped and its key deleted. */
export const KEY_IDLE_MS = 3_600_000;
export const STOPPED_MESSAGE = 'Stopped after 1 hour without progress, and the key was deleted. Paste the key again to resume.';

interface ImportRow {
  site_id: string;
  stripe_key: string | null;
  status: 'running' | 'done' | 'failed' | 'canceled' | 'stopped';
  since: number;
  cursor: string | null;
  cursor_ts: number | null;
  seen: number;
  recorded: number;
  skipped: number;
  error: string | null;
  started_at: number;
  updated_at: number;
}

/** What the dashboard sees: never the key. `progress` is the share of the time range covered, 0 to 1. */
function publicState(r: ImportRow | null) {
  if (!r) return { status: 'none' as const };
  const { stripe_key: _key, site_id: _site, ...rest } = r;
  const now = r.status === 'running' ? Date.now() : r.updated_at;
  const progress = r.status === 'done' ? 1 : r.cursor_ts ? Math.min(1, Math.max(0, (now - r.cursor_ts) / Math.max(1, now - r.since))) : 0;
  return { ...rest, progress };
}

/**
 * Stop the running imports (of one site, or all) that made no step for KEY_IDLE_MS, and delete their keys. Returns
 * how many it stopped; writes nothing when none is idle.
 */
export async function stopIdleImports(db: D1Database, now = Date.now(), siteId?: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE stripe_imports SET status = 'stopped', stripe_key = NULL, error = ?, updated_at = ?
       WHERE status = 'running' AND updated_at < ?${siteId ? ' AND site_id = ?' : ''}`,
    )
    .bind(STOPPED_MESSAGE, now, now - KEY_IDLE_MS, ...(siteId ? [siteId] : []))
    .run();
  return res.meta.changes;
}

/** The import's row, after stopping it if it sat idle too long. */
async function getRow(db: D1Database, siteId: string): Promise<ImportRow | null> {
  const row = await db.prepare('SELECT * FROM stripe_imports WHERE site_id = ?').bind(siteId).first<ImportRow>();
  if (row?.status === 'running' && row.updated_at < Date.now() - KEY_IDLE_MS && (await stopIdleImports(db, Date.now(), siteId))) {
    return db.prepare('SELECT * FROM stripe_imports WHERE site_id = ?').bind(siteId).first<ImportRow>();
  }
  return row;
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const idOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof obj(v).id === 'string' ? obj(v).id : null);

/** A D1Database that counts the queries made through it. */
function counting(db: D1Database, count: () => void): D1Database {
  const wrap = (inner: D1PreparedStatement): any => ({
    inner,
    bind: (...a: unknown[]) => wrap(inner.bind(...a)),
    first: (col?: string) => (count(), col ? inner.first(col) : inner.first()),
    all: () => (count(), inner.all()),
    run: () => (count(), inner.run()),
    raw: (o?: any) => (count(), inner.raw(o)),
  });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: any[]) => (count(), db.batch(stmts.map((s) => s.inner ?? s))),
    exec: (sql: string) => (count(), db.exec(sql)),
  } as unknown as D1Database;
}

/** Stripe ids of a charge that a stored payment may be keyed or linked by. */
const chargeKeys = (ch: Obj) => [ch.id, idOf(ch.payment_intent), idOf(ch.invoice)].filter((x): x is string => !!x);

/**
 * Store one charge the way its webhook events would have. Returns 'recorded' when it added a payment, else why not.
 */
export async function importCharge(db: D1Database, site: Site, ch: Obj): Promise<string> {
  if (ch.livemode === false) return 'test mode';
  if (ch.status !== 'succeeded' || ch.paid === false || ch.captured === false) return 'not paid';
  const created = Number(ch.created) || Math.floor(Date.now() / 1000);
  const inv = obj(ch.invoice);
  const pi = idOf(ch.payment_intent);
  let result: string;
  if (inv.id) {
    // The invoice names its subscription and billing reason (renewal or first payment).
    result = await handleStripeEvent(db, site, {
      type: 'invoice.paid',
      created,
      data: { object: { ...inv, payment_intent: inv.payment_intent ?? pi, charge: inv.charge ?? ch.id } },
    });
  } else if (pi) {
    const billing = obj(ch.billing_details);
    result = await handleStripeEvent(db, site, {
      type: 'payment_intent.succeeded',
      created,
      data: {
        object: {
          id: pi,
          amount_received: Number(ch.amount_captured) || Number(ch.amount) || 0,
          currency: ch.currency,
          metadata: ch.metadata,
          customer: ch.customer,
          receipt_email: ch.receipt_email ?? billing.email,
          latest_charge: ch.id,
          description: ch.description,
        },
      },
    });
  } else {
    result = await handleStripeEvent(db, site, { type: 'charge.succeeded', created, data: { object: ch } });
  }
  if (Number(ch.amount_refunded) > 0 && result !== 'other site' && result !== 'not pinned') {
    const refunds = Array.isArray(obj(ch.refunds).data) ? (obj(ch.refunds).data as Obj[]) : [];
    const last = Math.max(created, ...refunds.map((r) => Number(r.created) || 0));
    await handleStripeEvent(db, site, {
      type: 'charge.refunded',
      created: last,
      data: { object: { id: ch.id, payment_intent: pi, invoice: inv.id ?? null, amount_refunded: ch.amount_refunded, currency: ch.currency, refunds: { data: refunds } } },
    });
  }
  return result;
}

/** One step: the next page of charges, as far as the query budget goes. */
export async function importStep(db: D1Database, site: Site, fetchFn: typeof fetch = fetch) {
  const row = await getRow(db, site.id);
  if (!row || row.status !== 'running' || !row.stripe_key) return publicState(row);
  const url = new URL('https://api.stripe.com/v1/charges');
  url.searchParams.set('limit', String(PAGE));
  url.searchParams.set('created[gte]', String(Math.floor(row.since / 1000)));
  url.searchParams.append('expand[]', 'data.invoice');
  url.searchParams.append('expand[]', 'data.refunds');
  if (row.cursor) url.searchParams.set('starting_after', row.cursor);

  const now = Date.now();
  let page: Obj;
  try {
    const res = await fetchFn(url.toString(), { headers: { authorization: `Bearer ${row.stripe_key}`, 'stripe-version': STRIPE_IMPORT_VERSION } });
    page = await res.json<Obj>().catch(() => ({}));
    if (!res.ok) {
      const message = String(obj(page.error).message ?? `Stripe answered ${res.status}`).slice(0, 300);
      // A wrong or too narrow key will not get better; anything else (rate limit, Stripe down) is tried again next step.
      const fatal = res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404;
      await db
        .prepare(`UPDATE stripe_imports SET status = ?, stripe_key = CASE WHEN ? THEN NULL ELSE stripe_key END, error = ?, updated_at = ? WHERE site_id = ?`)
        .bind(fatal ? 'failed' : 'running', fatal ? 1 : 0, message, now, site.id)
        .run();
      return publicState(await getRow(db, site.id));
    }
  } catch (e) {
    await db.prepare('UPDATE stripe_imports SET error = ?, updated_at = ? WHERE site_id = ?').bind(`Could not reach Stripe: ${(e as Error).message}`.slice(0, 300), now, site.id).run();
    return publicState(await getRow(db, site.id));
  }

  const charges = Array.isArray(page.data) ? (page.data as Obj[]) : [];
  // Charges a webhook (or an earlier step) already stored, with their refunds, cost one query for the whole page.
  const keys = [...new Set(charges.flatMap(chargeKeys))];
  const known = new Set<string>();
  if (keys.length) {
    const marks = keys.map((_, i) => `?${i + 1}`).join(', ');
    const refundMarks = charges.map((_, i) => `?${keys.length + i + 1}`).join(', ');
    const res = await db
      .prepare(
        `SELECT id FROM payments WHERE id IN (${marks}) OR id IN (${refundMarks})
         UNION SELECT o.id FROM stripe_objects o JOIN payments p ON p.id = o.payment_id WHERE o.id IN (${marks})`,
      )
      .bind(...keys, ...charges.map((ch) => `stripe_refund_${ch.id}`))
      .all<{ id: string }>();
    for (const r of res.results) known.add(r.id);
  }

  let queries = 0;
  const cdb = counting(db, () => queries++);
  let { cursor, cursor_ts: cursorTs, seen, recorded, skipped } = row;
  let handled = 0;
  for (const ch of charges) {
    if (handled && queries >= QUERY_BUDGET) break;
    const stored = chargeKeys(ch).some((k) => known.has(k));
    const refundDone = !(Number(ch.amount_refunded) > 0) || known.has(`stripe_refund_${ch.id}`);
    const result = stored && refundDone ? 'already recorded' : await importCharge(cdb, site, ch);
    if (result === 'recorded') recorded++;
    else skipped++;
    seen++;
    handled++;
    cursor = String(ch.id);
    cursorTs = (Number(ch.created) || 0) * 1000;
  }
  const done = handled === charges.length && !page.has_more;
  await db
    .prepare(
      `UPDATE stripe_imports SET status = ?, stripe_key = CASE WHEN ? THEN NULL ELSE stripe_key END, cursor = ?, cursor_ts = ?, seen = ?,
         recorded = ?, skipped = ?, error = NULL, updated_at = ? WHERE site_id = ? AND status = 'running'`,
    )
    .bind(done ? 'done' : 'running', done ? 1 : 0, cursor, cursorTs, seen, recorded, skipped, Date.now(), site.id)
    .run();
  return publicState(await getRow(db, site.id));
}

export function registerStripeImportRoutes(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/stripe-import', async (c) => c.json(publicState(await getRow(c.env.DB, c.get('site').id))));

  app.post('/api/sites/:id/stripe-import', async (c) => {
    const b = await c.req.json<{ key?: unknown; months?: unknown }>().catch(() => ({}) as { key?: unknown; months?: unknown });
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (/^[rs]k_test_/.test(key)) return c.json({ error: 'That is a test mode key. Test payments are not revenue; use a live restricted key (rk_live_...)' }, 400);
    if (!/^rk_live_\w{10,}$/.test(key)) return c.json({ error: 'Use a restricted key that starts with rk_live_' }, 400);
    const months = Math.round(Number(b.months ?? 12));
    if (!(months >= 1 && months <= MAX_MONTHS)) return c.json({ error: `Choose 1 to ${MAX_MONTHS} months` }, 400);
    const site = c.get('site');
    const now = Date.now();
    // A stopped import (idle for an hour, key deleted) resumes from its cursor with the key pasted again.
    const prev = await getRow(c.env.DB, site.id);
    if (prev?.status === 'stopped') {
      await c.env.DB.prepare("UPDATE stripe_imports SET stripe_key = ?, status = 'running', error = NULL, updated_at = ? WHERE site_id = ? AND status = 'stopped'")
        .bind(key, now, site.id)
        .run();
      return c.json(await importStep(c.env.DB, site));
    }
    await c.env.DB.prepare(
      `INSERT INTO stripe_imports (site_id, stripe_key, status, since, cursor, cursor_ts, seen, recorded, skipped, error, started_at, updated_at)
       VALUES (?, ?, 'running', ?, NULL, NULL, 0, 0, 0, NULL, ?, ?)
       ON CONFLICT (site_id) DO UPDATE SET stripe_key = excluded.stripe_key, status = 'running', since = excluded.since, cursor = NULL,
         cursor_ts = NULL, seen = 0, recorded = 0, skipped = 0, error = NULL, started_at = excluded.started_at, updated_at = excluded.updated_at`,
    )
      .bind(site.id, key, now - months * MONTH_MS, now, now)
      .run();
    return c.json(await importStep(c.env.DB, site));
  });

  app.post('/api/sites/:id/stripe-import/step', async (c) => c.json(await importStep(c.env.DB, c.get('site'))));

  app.delete('/api/sites/:id/stripe-import', async (c) => {
    const site = c.get('site');
    await c.env.DB.prepare("UPDATE stripe_imports SET status = 'canceled', stripe_key = NULL, error = NULL, updated_at = ? WHERE site_id = ? AND status IN ('running', 'stopped')")
      .bind(Date.now(), site.id)
      .run();
    return c.json(publicState(await getRow(c.env.DB, site.id)));
  });
}
