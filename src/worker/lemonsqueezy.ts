import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { hmacHex, passwordsMatch } from './lib/crypto';
import { pusherOf, type Pusher } from './notify';
import { day, metaIds, minor, obj, providerSignal, providerSubscription, recordProviderPayment, setRefund, str, time } from './providers';
import { intervalFromSpan, priceOf, type SubEvent } from './subscriptions';

/**
 * Lemon Squeezy webhook: POST /api/webhooks/lemonsqueezy/:siteId, signed with the webhook's signing secret
 * (X-Signature: hex HMAC-SHA256 of the raw body).
 *
 *   order_created                  a paid order: one-time purchases and the first payment of a subscription
 *   order_refunded                 the order's refunded_amount, full or partial
 *   subscription_payment_success   renewals (billing_reason renewal or updated); the first payment is the order
 *   subscription_payment_refunded  a refunded renewal
 *   subscription_created           links the subscription to its order; a trial is stored as a trial signal
 *   subscription_updated           past_due: a billing issue
 *   subscription_payment_failed    a billing issue
 *   subscription_cancelled         a cancellation
 *   subscription_expired           an expiration
 *
 * Subscription events and payments also update the subscription's row in the subscriptions table (MRR).
 * Visitor ids come from meta.custom_data: checkout[custom][rt_visitor_id] on a checkout link (the tracker adds it) or
 * checkout_data.custom in the API. Lemon Squeezy repeats the checkout's custom data on the subscription's events.
 * Events with test_mode are acknowledged and ignored.
 */

export const LS_PROVIDER = 'lemonsqueezy';
const orderId = (id: string) => `ls_order_${id}`;
const invoiceId = (id: string) => `ls_invoice_${id}`;

export async function verifyLemonSqueezySignature(body: string, header: string | null | undefined, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  return passwordsMatch(header.trim().toLowerCase(), await hmacHex(secret, body));
}

export async function handleLemonSqueezyWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.lemonsqueezy_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);
  const body = await c.req.text();
  if (!(await verifyLemonSqueezySignature(body, c.req.header('x-signature'), site.lemonsqueezy_secret))) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = await handleLemonSqueezyEvent(c.env.DB, site, event, pusherOf(c), c.req.header('x-event-name'));
  // Every other event is acknowledged so Lemon Squeezy doesn't retry it.
  return c.json({ ok: true, result });
}

export async function handleLemonSqueezyEvent(db: D1Database, site: Site, event: Record<string, unknown>, push?: Pusher, header?: string): Promise<string> {
  const meta = obj(event.meta);
  const data = obj(event.data);
  const a = obj(data.attributes);
  const type = str(meta.event_name) ?? header ?? '';
  if (meta.test_mode === true || a.test_mode === true) return 'test mode';
  const id = str(data.id);
  if (!id) return 'ignored';
  const ids = metaIds(meta.custom_data);
  const ts = time(a.created_at) ?? Date.now();
  const currency = str(a.currency)?.toUpperCase() ?? site.currency;

  const order = () =>
    recordProviderPayment(db, site, {
      id: orderId(id),
      provider: LS_PROVIDER,
      ts,
      amount: minor(a.total),
      currency,
      meta: ids,
      customerId: str(a.customer_id),
      email: str(a.user_email),
      name: str(a.user_name),
      product: str(obj(a.first_order_item).product_name),
    }, push);

  switch (type) {
    case 'order_created':
      if (a.status !== 'paid' && a.status !== 'refunded' && a.status !== 'partial_refund') return 'not paid';
      return order();

    case 'order_refunded': {
      // The refund carries the whole order: store the order first in case its own event has not arrived.
      const stored = await order();
      if (stored === 'other site') return stored;
      return setRefund(db, site, { rowId: `ls_refund_${id}`, provider: LS_PROVIDER, paymentId: orderId(id), amount: minor(a.refunded_amount) || (a.refunded ? minor(a.total) : 0), ts: time(a.refunded_at) ?? Date.now() }, push);
    }

    case 'subscription_payment_success':
    case 'subscription_payment_refunded': {
      const sub = str(a.subscription_id);
      if (type === 'subscription_payment_success' && sub) {
        await providerSubscription(db, site, { id: sub, provider: LS_PROVIDER, at: ts, customerId: str(a.customer_id), paidAt: ts }, ids);
      }
      // The first payment of a subscription is also an order; order_created stores it.
      if (a.billing_reason === 'initial') return type === 'subscription_payment_success' ? 'first payment is the order' : 'refund the order';
      const product = sub
        ? ((await db.prepare('SELECT product FROM payments WHERE site_id = ? AND subscription_id = ? AND product IS NOT NULL LIMIT 1').bind(site.id, sub).first<{ product: string }>())?.product ?? null)
        : null;
      const stored = await recordProviderPayment(db, site, {
        id: invoiceId(id),
        provider: LS_PROVIDER,
        ts,
        amount: minor(a.total),
        currency,
        meta: ids,
        customerId: str(a.customer_id),
        email: str(a.user_email),
        name: str(a.user_name),
        subscriptionId: sub,
        product,
        renewal: true,
      }, push);
      if (type === 'subscription_payment_success' || stored === 'other site') return stored;
      return setRefund(db, site, { rowId: `ls_refund_invoice_${id}`, provider: LS_PROVIDER, paymentId: invoiceId(id), amount: minor(a.refunded_amount) || minor(a.total), ts: time(a.refunded_at) ?? Date.now() }, push);
    }

    case 'subscription_payment_failed': {
      const sub = str(a.subscription_id);
      if (!sub) return 'ignored';
      await providerSubscription(db, site, { id: sub, provider: LS_PROVIDER, at: ts, customerId: str(a.customer_id), billingIssueAt: ts }, ids);
      return providerSignal(db, site, { id: `ls_${sub}_billing_issue_${day(ts)}`, provider: LS_PROVIDER, ts, type: 'billing_issue', meta: ids, subscriptionId: sub, customerId: str(a.customer_id) }, push);
    }

    case 'subscription_created':
    case 'subscription_updated':
    case 'subscription_cancelled':
    case 'subscription_expired': {
      const at = time(a.updated_at) ?? ts;
      if (type === 'subscription_created' && str(a.order_id) && (!ids.siteId || ids.siteId === site.id)) {
        // The order's row learns its subscription, so renewals and signals find the buyer through it.
        await db
          .prepare('UPDATE payments SET subscription_id = ? WHERE site_id = ? AND id = ? AND subscription_id IS NULL')
          .bind(id, site.id, orderId(str(a.order_id)!))
          .run();
      }
      await providerSubscription(db, site, await subscriptionEvent(db, site, id, a, at, type === 'subscription_created'), ids);
      const signal =
        type === 'subscription_created' ? (a.status === 'on_trial' ? 'trial_start' : null)
        : type === 'subscription_updated' ? (a.status === 'past_due' ? 'billing_issue' : null)
        : type === 'subscription_cancelled' ? 'cancellation'
        : 'expiration';
      if (!signal) return type === 'subscription_created' ? 'linked' : 'updated';
      return providerSignal(db, site, {
        id: `ls_${id}_${signal}_${day(at)}`,
        provider: LS_PROVIDER,
        ts: at,
        type: signal,
        meta: ids,
        subscriptionId: id,
        customerId: str(a.customer_id),
        product: str(a.product_name),
      }, push);
    }
  }
  return 'ignored';
}

/**
 * A Lemon Squeezy subscription object as a subscriptions-table event. The object has no price: it comes from the first
 * order and the time to the first renewal, read when the subscription is created (later, renews_at has moved on).
 */
async function subscriptionEvent(db: D1Database, site: Site, id: string, a: Record<string, any>, at: number, created: boolean): Promise<SubEvent> {
  const status = str(a.status) ?? '';
  const startedAt = time(a.created_at) ?? at;
  const trialEnd = time(a.trial_ends_at);
  const renews = time(a.renews_at);
  const ends = time(a.ends_at);
  const trial = status === 'on_trial';
  const ended = status === 'expired';
  const ev: SubEvent = {
    id,
    provider: LS_PROVIDER,
    at,
    customerId: str(a.customer_id),
    product: str(a.product_name),
    startedAt,
    trialStart: trialEnd ? startedAt : null,
    trialEnd,
    paidAt: trial || status === 'unpaid' ? undefined : trialEnd ? Math.min(trialEnd, at) : startedAt,
    expiresAt: trial ? trialEnd : (ends ?? renews),
    canceledAt: a.cancelled === true || status === 'cancelled' || ended ? at : null,
    endedAt: ended ? (ends ?? at) : null,
    billingIssueAt: status === 'past_due' || status === 'unpaid' ? at : undefined,
  };
  const order = str(a.order_id);
  const span = created && !trial && renews ? intervalFromSpan(renews - startedAt) : null;
  if (order && span) {
    const paid = await db
      .prepare("SELECT amount, currency FROM payments WHERE site_id = ? AND id = ? AND kind = 'payment'")
      .bind(site.id, orderId(order))
      .first<{ amount: number; currency: string }>();
    if (paid) Object.assign(ev, { price: priceOf(paid.amount, paid.currency, span.interval, span.count), weakPrice: true });
  }
  return ev;
}
