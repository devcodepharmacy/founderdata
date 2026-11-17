import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { hmacHex, passwordsMatch } from './lib/crypto';
import { pusherOf, type Pusher } from './notify';
import { metaIds, minor, obj, providerSignal, providerSubscription, recordProviderPayment, setRefund, str, time } from './providers';
import { priceOf, type Interval, type Price, type SubEvent } from './subscriptions';

/**
 * Paddle Billing webhook: POST /api/webhooks/paddle/:siteId, signed with the notification destination's secret key
 * (Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256 of "<ts>:<raw body>">).
 *
 *   transaction.completed  a paid transaction: checkouts and renewals (origin subscription_recurring)
 *   adjustment.created     refunds and chargebacks, once Paddle approves them
 *   adjustment.updated     an approved refund counts, a rejected or reversed one comes back off
 *   subscription.created   a trial (status trialing) is stored as a trial signal
 *   subscription.canceled  a cancellation
 *   subscription.past_due  a billing issue
 *   subscription.*         every subscription event, and each paid transaction of a subscription, also updates the
 *                          subscription's row in the subscriptions table (MRR)
 *
 * Visitor ids come from the transaction's custom_data: pass customData from window.founderdata.attribution() to
 * Paddle.Checkout.open(). Paddle's sandbox has its own notification destinations; connect only the live one.
 */

export const PADDLE_PROVIDER = 'paddle';
const txnId = (id: string) => `paddle_${id}`;

export async function verifyPaddleSignature(body: string, header: string | null | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  let ts = '';
  const sigs: string[] = [];
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s?.trim());
    if (k === 'ts') ts = v ?? '';
    else if (k === 'h1' && v) sigs.push(v.toLowerCase());
  }
  const t = Number(ts);
  if (!ts || !Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > 5 * 60) return false;
  const expected = await hmacHex(secret, `${ts}:${body}`);
  return sigs.some((s) => passwordsMatch(s, expected));
}

export async function handlePaddleWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.paddle_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);
  const body = await c.req.text();
  if (!(await verifyPaddleSignature(body, c.req.header('paddle-signature'), site.paddle_secret))) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = await handlePaddleEvent(c.env.DB, site, event, pusherOf(c));
  // Every other event is acknowledged so Paddle doesn't retry it.
  return c.json({ ok: true, result });
}

export async function handlePaddleEvent(db: D1Database, site: Site, event: Record<string, unknown>, push?: Pusher): Promise<string> {
  const o = obj(event.data);
  const type = str(event.event_type) ?? '';
  const id = str(o.id);
  if (!id) return 'ignored';
  const ids = metaIds(o.custom_data);
  const occurred = time(event.occurred_at) ?? Date.now();

  switch (type) {
    case 'transaction.completed':
    case 'transaction.paid': {
      // transaction.paid comes first for automatic payments; both carry the same transaction, stored once.
      const totals = obj(obj(o.details).totals);
      const item = obj(obj(o.details).line_items?.[0]);
      const sub = str(o.subscription_id);
      const paidAt = time(o.billed_at) ?? time(o.created_at) ?? occurred;
      if (sub && minor(totals.total ?? totals.grand_total) > 0 && (!ids.siteId || ids.siteId === site.id)) {
        await providerSubscription(db, site, { id: sub, provider: PADDLE_PROVIDER, at: paidAt, customerId: str(o.customer_id), paidAt }, ids);
      }
      return recordProviderPayment(db, site, {
        id: txnId(id),
        provider: PADDLE_PROVIDER,
        ts: time(o.billed_at) ?? time(o.created_at) ?? occurred,
        amount: minor(totals.total ?? totals.grand_total),
        currency: str(o.currency_code)?.toUpperCase() ?? site.currency,
        meta: ids,
        customerId: str(o.customer_id),
        subscriptionId: str(o.subscription_id),
        product: str(obj(item.product).name) ?? str(obj(obj(o.items?.[0]).price).description),
        renewal: o.origin === 'subscription_recurring',
      }, push);
    }

    case 'adjustment.created':
    case 'adjustment.updated': {
      if (o.action !== 'refund' && o.action !== 'chargeback') return 'not a refund';
      const txn = str(o.transaction_id);
      if (!txn) return 'no payment';
      // Approved takes money back; pending waits, rejected or reversed gives it back.
      const amount = o.status === 'approved' ? minor(obj(o.totals).total) : 0;
      if (o.status === 'pending_approval') return 'pending';
      return setRefund(db, site, { rowId: `paddle_${id}`, provider: PADDLE_PROVIDER, paymentId: txnId(txn), amount, ts: time(o.updated_at) ?? time(o.created_at) ?? occurred }, push);
    }

    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.trialing':
    case 'subscription.resumed':
    case 'subscription.paused':
    case 'subscription.canceled':
    case 'subscription.past_due': {
      await providerSubscription(db, site, subscriptionEvent(id, o, occurred), ids);
      if (type !== 'subscription.created' && type !== 'subscription.canceled' && type !== 'subscription.past_due') return 'updated';
      const signal = type === 'subscription.created' ? (o.status === 'trialing' ? 'trial_start' : null) : type === 'subscription.canceled' ? 'cancellation' : 'billing_issue';
      if (!signal) return 'ignored';
      return providerSignal(db, site, {
        // A retry keeps its event_id.
        id: `paddle_${str(event.event_id) ?? `${id}_${signal}`}`,
        provider: PADDLE_PROVIDER,
        ts: occurred,
        type: signal,
        meta: ids,
        subscriptionId: id,
        customerId: str(o.customer_id),
        product: str(obj(obj(o.items?.[0]).product).name) ?? str(obj(obj(o.items?.[0]).price).description),
      }, push);
    }
  }
  return 'ignored';
}

const INTERVALS = new Set(['day', 'week', 'month', 'year']);

/** A Paddle Subscription object as a subscriptions-table event. The items' prices add up to one price per period. */
function subscriptionEvent(id: string, o: Record<string, any>, at: number): SubEvent {
  const status = str(o.status) ?? '';
  const items: Record<string, any>[] = Array.isArray(o.items) ? o.items.map(obj) : [];
  const prices = items
    .map((it): Price | null => {
      const price = obj(it.price);
      const cycle = obj(price.billing_cycle);
      const amount = minor(obj(price.unit_price).amount) * (minor(it.quantity) || 1);
      const currency = str(obj(price.unit_price).currency_code) ?? str(o.currency_code);
      return amount > 0 && currency && INTERVALS.has(cycle.interval) ? priceOf(amount, currency, cycle.interval as Interval, minor(cycle.frequency) || 1) : null;
    })
    .filter((p): p is Price => !!p);
  const first = prices[0];
  const trial = obj(items[0]?.trial_dates);
  const startedAt = time(o.started_at) ?? time(o.created_at) ?? at;
  const ended = status === 'canceled' || status === 'paused';
  const scheduled = obj(o.scheduled_change).action === 'cancel';
  return {
    id,
    provider: PADDLE_PROVIDER,
    at: time(o.updated_at) ?? at,
    customerId: str(o.customer_id),
    product: str(obj(items[0]?.product).name) ?? str(obj(items[0]?.price).description),
    price: first && prices.every((p) => p.interval === first.interval && p.count === first.count && p.currency === first.currency)
      ? priceOf(prices.reduce((n, p) => n + p.amount, 0), first.currency, first.interval, first.count)
      : first,
    startedAt,
    trialStart: time(trial.starts_at),
    trialEnd: time(trial.ends_at),
    paidAt: time(o.first_billed_at) ?? undefined,
    expiresAt: time(obj(o.current_billing_period).ends_at) ?? time(o.next_billed_at),
    canceledAt: ended || scheduled ? (time(o.canceled_at) ?? time(o.updated_at) ?? at) : null,
    endedAt: ended ? (time(o.canceled_at) ?? time(o.paused_at) ?? at) : null,
    billingIssueAt: status === 'past_due' ? (time(o.updated_at) ?? at) : undefined,
  };
}
