import type { Context } from 'hono';
import { forgetSite, getSite, type AppEnv, type Site } from './env';
import { passwordsMatch } from './lib/crypto';
import { pusherOf, type Pusher } from './notify';
import { day, metaIds, minor, providerSignal, providerSubscription, recordProviderPayment, setRefund, time } from './providers';
import { priceOf, type Interval } from './subscriptions';

/**
 * Gumroad ping: POST /api/webhooks/gumroad/:siteId/:token, form-encoded.
 *
 * Gumroad signs nothing, so the URL is the secret: a random token FounderData makes in Settings. Every sale and refund
 * ping must also name the site's seller id: typed in Settings, or saved from the first sale ping that has the token. Anyone who learns the URL can post fake sales, so keep it out of public
 * code and make a new one in Settings if it leaks. A seller id alone proves nothing: it shows in your public pages.
 * Cancellation and subscription_ended pings name no seller, so only the token checks them.
 *
 *   sale (the account's Ping URL, or resource subscription "sale")   a sale; is_recurring_charge marks a renewal
 *   refund                                                            the sale's refund (refunded=true)
 *   cancellation                                                      a cancellation
 *   subscription_ended                                                an expiration
 *
 * Visitor ids come from url_params: the tracker adds rt_visitor_id and rt_session_id to gumroad.com/l/ links and to
 * links on your *.gumroad.com profile. Test purchases (test=true) are acknowledged and ignored.
 */

export const GUMROAD_PROVIDER = 'gumroad';
/** Characters of a seller id kept; the same limit as a seller id typed in Settings (providers.ts). */
const SELLER_ID_MAX = 100;
const sellerId = (v: string | undefined) => (v ?? '').trim().slice(0, SELLER_ID_MAX);
const saleId = (id: string) => `gumroad_${id}`;

/** The form fields, with url_params[...] collected into one object. */
export function parsePing(body: string) {
  const f: Record<string, string> = {};
  const urlParams: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const m = k.match(/^url_params\[(.+)\]$/);
    if (m) urlParams[m[1]] = v;
    else f[k] = v;
  }
  return { f, urlParams };
}

export async function handleGumroadPing(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.gumroad_token) return c.json({ error: 'Gumroad not configured for this site' }, 400);
  if (!passwordsMatch(c.req.param('token') ?? '', site.gumroad_token)) return c.json({ error: 'invalid token' }, 401);
  const { f, urlParams } = parsePing(await c.req.text());
  // Sales and refunds name the seller. Cancellation and subscription_ended pings carry no seller id; the token checks those.
  const money = !f.resource_name || f.resource_name === 'sale' || f.resource_name === 'refund';
  // Stored and compared the same way: the column keeps the first SELLER_ID_MAX characters.
  const seller = sellerId(f.seller_id);
  if (money && !seller) return c.json({ error: 'no seller id' }, 401);
  if (!site.gumroad_seller_id && money) {
    // The first sale with the right token names the seller; later pings must name the same one.
    const pinned = await c.env.DB.prepare('UPDATE sites SET gumroad_seller_id = ? WHERE id = ? AND gumroad_seller_id IS NULL').bind(seller, site.id).run();
    forgetSite(site.id);
    // Another ping pinned a seller a moment earlier: it has to be this one.
    const now = pinned.meta.changes ? null : await c.env.DB.prepare('SELECT gumroad_seller_id AS s FROM sites WHERE id = ?').bind(site.id).first<{ s: string | null }>();
    if (now && now.s !== seller) return c.json({ error: 'seller id does not match' }, 401);
  } else if ((money || seller) && seller !== site.gumroad_seller_id) {
    return c.json({ error: 'seller id does not match' }, 401);
  }
  const result = await handleGumroadEvent(c.env.DB, site, f, urlParams, pusherOf(c));
  // Gumroad retries anything but a 200.
  return c.json({ ok: true, result });
}

export async function handleGumroadEvent(db: D1Database, site: Site, f: Record<string, string>, urlParams: Record<string, string>, push?: Pusher): Promise<string> {
  if (f.test === 'true') return 'test mode';
  const ids = metaIds(urlParams);
  const resource = f.resource_name || 'sale';
  const sub = f.subscription_id || null;

  if (resource === 'cancellation' || resource === 'subscription_ended') {
    if (!sub) return 'ignored';
    const ts = time(f.cancelled_at) ?? time(f.ended_at) ?? Date.now();
    const type = resource === 'cancellation' ? 'cancellation' : 'expiration';
    await providerSubscription(db, site, {
      id: sub,
      provider: GUMROAD_PROVIDER,
      at: ts,
      product: f.product_name || null,
      ...(type === 'cancellation' ? { canceledAt: ts } : { canceledAt: ts, endedAt: ts }),
    }, ids);
    return providerSignal(db, site, {
      id: `gumroad_${sub}_${type}_${day(ts)}`,
      provider: GUMROAD_PROVIDER,
      ts,
      type,
      meta: ids,
      subscriptionId: sub,
      customerId: f.user_id || f.purchaser_id || null,
      product: f.product_name || null,
      reason: f.ended_reason || null,
    }, push);
  }
  if (resource !== 'sale' && resource !== 'refund') return 'ignored';

  const id = f.sale_id;
  if (!id) return 'ignored';
  // A refund ping carries the whole sale: store the sale first in case its own ping has not arrived.
  const stored = await recordProviderPayment(db, site, {
    id: saleId(id),
    provider: GUMROAD_PROVIDER,
    ts: time(f.sale_timestamp) ?? Date.now(),
    // In the minor unit of `currency` (cents for USD).
    amount: minor(f.price),
    currency: (f.currency || 'USD').toUpperCase(),
    meta: ids,
    customerId: f.purchaser_id || null,
    email: f.email || null,
    name: f.full_name || null,
    subscriptionId: sub,
    product: f.product_name || null,
    renewal: f.is_recurring_charge === 'true',
  }, push);
  const period = RECURRENCE[f.recurrence ?? ''];
  if (sub && stored !== 'other site' && resource === 'sale' && f.refunded !== 'true') {
    const ts = time(f.sale_timestamp) ?? Date.now();
    const amount = minor(f.price);
    await providerSubscription(db, site, {
      id: sub,
      provider: GUMROAD_PROVIDER,
      at: ts,
      customerId: f.purchaser_id || null,
      product: f.product_name || null,
      price: period && amount > 0 ? priceOf(amount, f.currency || 'USD', period[0], period[1]) : undefined,
      startedAt: f.is_recurring_charge === 'true' ? undefined : ts,
      paidAt: ts,
    }, ids);
  }
  if (f.refunded !== 'true' || stored === 'other site') return stored;
  const refunded = minor(f.amount_refunded_cents) || minor(f.price);
  return setRefund(db, site, { rowId: `gumroad_refund_${id}`, provider: GUMROAD_PROVIDER, paymentId: saleId(id), amount: refunded, ts: Date.now() }, push);
}

/** Gumroad's recurrence names as a billing period. */
const RECURRENCE: Record<string, [Interval, number]> = {
  monthly: ['month', 1],
  quarterly: ['month', 3],
  biannually: ['month', 6],
  yearly: ['year', 1],
  every_two_years: ['year', 2],
};
