import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { verifyStandardWebhook } from './lib/crypto';
import { announce, pusherOf, type Pusher } from './notify';
import { recordPayment } from './payments';
import { providerSignal, providerSubscription } from './providers';
import { intervalFromName, intervalFromSpan, periodMs, priceOf, type Interval, type SubEvent } from './subscriptions';

/**
 * Dodo Payments webhook: POST /api/webhooks/dodo/:siteId, signed the Standard Webhooks way (webhook-id,
 * webhook-timestamp, webhook-signature) with the site's dodo_webhook_secret (docs/GUIDE.md, "Revenue attribution with
 * Dodo Payments").
 *
 *   payment.succeeded         a payment: one-time purchases, the first subscription payment and renewals. A payment
 *                             of a subscription also updates the subscription's row (paid until one period later)
 *   refund.succeeded          a refund, credited like the payment it takes back
 *   subscription.active       the subscription started (a trial in progress is stored as a trial signal)
 *   subscription.renewed      a renewal: the next billing date moves
 *   subscription.plan_changed a new product or price: an upgrade or a downgrade
 *   subscription.on_hold      a renewal payment failed: a billing issue
 *   subscription.cancelled, subscription.expired, subscription.failed
 *                             the subscription ended
 *   subscription.updated      any other change, read like the events above
 *
 * Visitor ids come from the payment's or subscription's metadata (rt_visitor_id / rt_session_id, which
 * attribution() returns), else from the return page (?payment_id=) and the other fallbacks in payments.ts attribute().
 */

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const time = (v: unknown): number | null => (typeof v === 'string' ? Date.parse(v) || null : null);
const DAY = 86_400_000;

export const DODO_PROVIDER = 'dodo';

function pickMeta(meta: Obj, keys: string[]): string | null {
  for (const k of keys) if (str(meta[k])) return meta[k] as string;
  return null;
}

/** The visitor, visit and site ids in a payment's or subscription's metadata (or its customer's). */
function idsOf(data: Obj) {
  const meta = { ...obj(obj(data.customer).metadata), ...obj(data.metadata) };
  return {
    visitorId: pickMeta(meta, ['rt_visitor_id', 'ml_visitor_id', 'visitor_id', 'minilytics_visitor_id']),
    sessionId: pickMeta(meta, ['rt_session_id', 'ml_session_id', 'session_id', 'minilytics_session_id']),
    siteId: pickMeta(meta, ['rt_site_id', 'ml_site_id']),
  };
}

export async function handleDodoWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.dodo_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);
  const body = await c.req.text();
  const headers = {
    id: c.req.header('webhook-id') ?? null,
    timestamp: c.req.header('webhook-timestamp') ?? null,
    signature: c.req.header('webhook-signature') ?? null,
  };
  if (!(await verifyStandardWebhook(site.dodo_webhook_secret, headers, body))) return c.json({ error: 'invalid signature' }, 401);
  let event: Obj;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = await handleDodoEvent(c.env.DB, site, event, headers.id ?? '', pusherOf(c));
  // Every other event type is acknowledged so Dodo doesn't retry it.
  return c.json({ ok: true, result });
}

/** One verified Dodo event. Exported for tests. */
export async function handleDodoEvent(db: D1Database, site: Site, event: Obj, messageId: string, push?: Pusher): Promise<string> {
  const type = str(event.type) ?? '';
  const data = obj(event.data);
  const customer = obj(data.customer);
  const ids = idsOf(data);
  if (ids.siteId && ids.siteId !== site.id) return 'other site';
  const ts = time(data.created_at) ?? time(event.timestamp) ?? Date.now();
  const customerId = str(customer.customer_id) ?? str(data.customer_id);

  if (type === 'payment.succeeded') {
    const paymentId = str(data.payment_id);
    if (!paymentId) return 'ignored';
    // Payment ids are global: a Dodo account whose webhook reaches several sites stores each payment once.
    const owner = await db.prepare('SELECT site_id FROM payments WHERE id = ?').bind(paymentId).first<{ site_id: string }>();
    if (owner && owner.site_id !== site.id) return 'other site';
    let amount = Number(data.total_amount) || 0;
    let currency = String(data.currency ?? site.currency);
    if (currency.toUpperCase() !== site.currency && str(data.settlement_currency)?.toUpperCase() === site.currency) {
      amount = Number(data.settlement_amount) || amount;
      currency = data.settlement_currency;
    }
    const subscriptionId = str(data.subscription_id) ?? (Array.isArray(data.subscription_ids) ? str(data.subscription_ids[0]) : null);
    const product = productOf(data);
    const res = await recordPayment(db, site, {
      id: paymentId,
      provider: DODO_PROVIDER,
      ts,
      amount,
      kind: 'payment',
      currency,
      visitorId: ids.visitorId,
      sessionId: ids.sessionId,
      customerId,
      email: str(customer.email)?.toLowerCase() ?? null,
      name: str(customer.name),
      subscriptionId,
      product,
    }, { push });
    if (subscriptionId) {
      // The price before tax, in the currency the customer paid, like the subscription's recurring_pre_tax_amount.
      const preTax = (Number(data.total_amount) || 0) - (num(data.tax) ?? 0);
      const ev = await paymentSubscriptionEvent(db, site, subscriptionId, { ts, amount: preTax, currency: String(data.currency ?? site.currency), product, customerId });
      await providerSubscription(db, site, ev, ids);
    }
    return res.inserted ? 'recorded' : 'already recorded';
  }

  if (type === 'refund.succeeded') {
    const original = await db.prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?')
      .bind(String(data.payment_id), site.id)
      .first<{ visitor_id: string | null; session_id: string | null; currency: string; amount: number; product: string | null; subscription_id: string | null; channel: string | null; source: string | null; campaign: string | null }>();
    const amount = Number(data.amount) || original?.amount || 0;
    const refundId = String(data.refund_id ?? `refund_${data.payment_id}`);
    const refundCurrency = String(data.currency ?? original?.currency ?? site.currency).toUpperCase();
    const res = await db.prepare(
      `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name, product, subscription_id,
                                       channel, source, campaign)
       VALUES (?, ?, 'dodo', ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        refundId,
        site.id,
        ts,
        -Math.abs(amount),
        refundCurrency,
        original?.visitor_id ?? null,
        original?.session_id ?? null,
        customerId,
        str(customer.email)?.toLowerCase() ?? null,
        str(customer.name),
        original?.product ?? null,
        original?.subscription_id ?? null,
        original?.channel ?? null,
        original?.source ?? null,
        original?.campaign ?? null,
      )
      .run();
    if (res.meta.changes) {
      await announce(push, site, {
        event: 'refund',
        id: refundId,
        provider: DODO_PROVIDER,
        sandbox: false,
        amount,
        currency: refundCurrency,
        product: original?.product,
        sessionId: original?.session_id,
      });
    }
    return res.meta.changes ? 'refund recorded' : 'already recorded';
  }

  if (type.startsWith('subscription.')) {
    // The event's own time orders the subscription's state; created_at is when the subscription began.
    const at = time(event.timestamp) ?? Date.now();
    const ev = dodoSubscriptionEvent(data, at, type);
    if (!ev) return 'ignored';
    await providerSubscription(db, site, ev, ids);
    const signal =
      type === 'subscription.active' && ev.trialEnd != null && ev.trialEnd > at ? 'trial_start'
      : type === 'subscription.cancelled' ? 'cancellation'
      : type === 'subscription.expired' ? 'expiration'
      : type === 'subscription.on_hold' ? 'billing_issue'
      : null;
    if (!signal) return 'subscription';
    return providerSignal(db, site, {
      // A retry of a webhook keeps its webhook-id.
      id: `dodo_${messageId || `${ev.id}_${signal}_${at}`}`,
      provider: DODO_PROVIDER,
      ts: signal === 'trial_start' ? (ev.trialStart ?? at) : at,
      type: signal,
      meta: ids,
      subscriptionId: ev.id,
      customerId: ev.customerId ?? null,
      product: ev.product ?? null,
    }, push);
  }
  return 'ignored';
}

/** The product a payment is for: the first product in its cart, else its subscription's product. */
function productOf(data: Obj): string | null {
  const cart = Array.isArray(data.product_cart) ? data.product_cart : [];
  return str(obj(cart[0]).product_id) ?? str(data.product_id);
}

const INTERVALS: Record<string, Interval> = { day: 'day', week: 'week', month: 'month', year: 'year' };
/** Dodo's payment_frequency_interval ("Day", "Week", "Month", "Year"). */
const intervalOf = (v: unknown): Interval | null => INTERVALS[String(v ?? '').toLowerCase()] ?? null;

/**
 * A Dodo Subscription object as a subscriptions-table event. The price is recurring_pre_tax_amount per
 * payment_frequency_count x payment_frequency_interval, so a yearly plan counts a twelfth of its price as MRR.
 * Exported for tests.
 */
export function dodoSubscriptionEvent(o: Obj, at: number, type = ''): SubEvent | null {
  const id = str(o.subscription_id);
  if (!id) return null;
  const status = str(o.status) ?? '';
  const interval = intervalOf(o.payment_frequency_interval);
  const amount = num(o.recurring_pre_tax_amount);
  const currency = str(o.currency);
  const started = time(o.created_at) ?? at;
  const trialDays = num(o.trial_period_days) ?? 0;
  const trialEnd = trialDays > 0 ? started + trialDays * DAY : null;
  const inTrial = trialEnd !== null && at < trialEnd;
  const ended = status === 'cancelled' || status === 'expired' || status === 'failed';
  const paid = status === 'active' && !inTrial;
  return {
    id,
    provider: DODO_PROVIDER,
    at,
    customerId: str(obj(o.customer).customer_id) ?? str(o.customer_id),
    product: str(o.product_id),
    price: amount !== null && amount > 0 && interval && currency ? priceOf(amount, currency, interval, num(o.payment_frequency_count) || 1) : undefined,
    // The first payment's price: a payment.succeeded that came first only guessed the period.
    paidPrice: type === 'subscription.active' || undefined,
    startedAt: started,
    trialStart: trialEnd !== null ? started : undefined,
    trialEnd: trialEnd ?? undefined,
    paidAt: paid ? (time(o.previous_billing_date) ?? started) : undefined,
    expiresAt: ended ? undefined : (time(o.next_billing_date) ?? undefined),
    canceledAt: ended || o.cancel_at_next_billing_date === true ? (time(o.cancelled_at) ?? at) : null,
    endedAt: ended ? at : null,
    billingIssueAt: status === 'on_hold' ? at : undefined,
  };
}

/**
 * What a payment of a subscription says about it: paid at `ts`, until one period later. The period is the one a
 * subscription event named. Without one (a site that only sends payment events), the second payment learns it from
 * the gap since the first, and replaces the first payment's guess (the product's name, else a month). Later payments
 * keep it. The price only fills a row that no subscription event has priced.
 */
async function paymentSubscriptionEvent(
  db: D1Database,
  site: Site,
  id: string,
  p: { ts: number; amount: number; currency: string; product: string | null; customerId: string | null },
): Promise<SubEvent> {
  const r = await db
    .prepare('SELECT interval, interval_count, paid_at, renewed_at, updated_at FROM subscriptions WHERE site_id = ? AND id = ?')
    .bind(site.id, id)
    .first<{ interval: Interval | null; interval_count: number | null; paid_at: number | null; renewed_at: number | null; updated_at: number }>();
  // updated_at stays 0 while only payments touched the row (they are weak events), and renewed_at = paid_at while it
  // has seen one payment: its period is still the first payment's guess.
  const guessed = !!r && !(r.updated_at > 0) && r.paid_at != null && r.renewed_at === r.paid_at;
  const gap = guessed ? intervalFromSpan(p.ts - r!.renewed_at!) : null;
  const span = gap ?? (r?.interval ? { interval: r.interval, count: r.interval_count ?? 1 } : null) ?? intervalFromName(p.product);
  const paid = p.amount > 0;
  return {
    id,
    provider: DODO_PROVIDER,
    at: p.ts,
    customerId: p.customerId,
    product: p.product,
    price: paid ? priceOf(p.amount, p.currency, span.interval, span.count) : undefined,
    weakPrice: true,
    paidPrice: paid && gap ? true : undefined,
    periodFix: paid && gap ? true : undefined,
    paidAt: paid ? p.ts : undefined,
    expiresAt: paid ? p.ts + periodMs(span.interval, span.count) : undefined,
  };
}
