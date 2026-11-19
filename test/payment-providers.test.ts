// Lemon Squeezy, Polar, Paddle and Gumroad webhooks, other revenue in the payments API, the Stripe history import,
// and the tracker's link tagging for the new checkouts.
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetSite } from '../src/worker/env';
import { importStep } from '../src/worker/stripe-import';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const LS_SECRET = 'ls_signing_secret_123';
const POLAR_SECRET = 'polar_whs_0123456789abcdef';
const PADDLE_SECRET = 'pdl_ntfset_01abc_secretvalue';
const STRIPE_SECRET = 'whsec_import_test_secret';

let w: TestWorker;
let site: any;
const now = () => Math.floor(Date.now() / 1000);
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 10)}`;
const payment = (id: string) => w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<any>();
const count = async (sql: string, ...binds: unknown[]) => (await w.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const visit = async (siteId = site.id, source = 'news.ycombinator.com') => {
  const vid = crypto.randomUUID(), sid = crypto.randomUUID();
  await w.fetch('/api/event', {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: JSON.stringify({ w: siteId, t: 'pageview', u: 'https://shop.example/pricing', r: `https://${source}/item`, vid, sid }),
  });
  return { vid, sid };
};

beforeAll(async () => {
  w = await startWorker();
  site = await w.createSite({
    domain: 'shop.example',
    lemonsqueezy_secret: LS_SECRET,
    polar_secret: POLAR_SECRET,
    paddle_secret: PADDLE_SECRET,
    gumroad_seller_id: 'seller_abc123',
    gumroad_new_token: true,
    stripe_webhook_secret: STRIPE_SECRET,
  });
});
afterAll(() => w.dispose());

describe('provider settings', () => {
  it('masks the signing secrets, shows the Gumroad token, and rejects bad values', async () => {
    expect(site).toMatchObject({ lemonsqueezy_secret: '••••••••', polar_secret: '••••••••', paddle_secret: '••••••••', gumroad_seller_id: 'seller_abc123' });
    expect(site.gumroad_token).toMatch(/^\w{16,}$/);
    const listed = (await w.admin('/api/sites')).body.find((s: any) => s.id === site.id);
    expect(listed.paddle_secret).toBe('••••••••');
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { polar_secret: 'has space inside' } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { gumroad_seller_id: 'bad id!' } })).status).toBe(400);
    // Saving the masked value keeps the secret.
    const same = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { polar_secret: '••••••••', gumroad_seller_id: 'seller_abc123' } });
    expect(same.body.polar_secret).toBe('••••••••');
    expect(same.body.gumroad_token).toBe(site.gumroad_token);
    forgetSite(site.id);
  });
});

// ---------- Lemon Squeezy

const lsSign = (body: string, secret = LS_SECRET) => createHmac('sha256', secret).update(body).digest('hex');
async function ls(event: string, data: Record<string, unknown>, opts: { custom?: Record<string, unknown>; test?: boolean; secret?: string; siteId?: string } = {}) {
  const body = JSON.stringify({ meta: { event_name: event, custom_data: opts.custom, test_mode: opts.test ?? false }, data });
  const res = await w.fetch(`/api/webhooks/lemonsqueezy/${opts.siteId ?? site.id}`, {
    method: 'POST',
    headers: { 'x-signature': lsSign(body, opts.secret), 'x-event-name': event, 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, body: (await res.json()) as any };
}
const lsOrder = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'orders',
  id,
  attributes: {
    status: 'paid', total: 2900, currency: 'USD', customer_id: 77, user_email: 'Ana@Example.com', user_name: 'Ana',
    first_order_item: { product_name: 'Pro license' }, created_at: iso(), test_mode: false, refunded_amount: 0, ...over,
  },
});

describe('Lemon Squeezy webhook', () => {
  it('checks the signature', async () => {
    expect((await ls('order_created', lsOrder('1'), { secret: 'wrong' })).status).toBe(401);
    const plain = await w.createSite();
    expect((await ls('order_created', lsOrder('1'), { siteId: plain.id })).status).toBe(400);
    expect((await ls('order_created', lsOrder('1'), { siteId: 'nope' })).status).toBe(404);
  });

  it('records an order once, attributed through custom data, and its refunds', async () => {
    const { vid, sid } = await visit();
    const first = await ls('order_created', lsOrder('1001'), { custom: { rt_visitor_id: vid, rt_session_id: sid } });
    expect(first.body.result).toBe('recorded');
    expect(await payment('ls_order_1001')).toMatchObject({ provider: 'lemonsqueezy', amount: 2900, currency: 'USD', visitor_id: vid, session_id: sid, matched_by: 'metadata', email: 'ana@example.com', product: 'Pro license', customer_id: '77' });
    expect((await ls('order_created', lsOrder('1001'), { custom: { rt_visitor_id: vid } })).body.result).toBe('already recorded');
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE id LIKE 'ls_order_1001%'")).toBe(1);

    expect((await ls('order_refunded', lsOrder('1001', { status: 'partial_refund', refunded: true, refunded_amount: 900 }))).body.result).toBe('refund recorded');
    expect(await payment('ls_refund_1001')).toMatchObject({ kind: 'refund', amount: -900, visitor_id: vid, session_id: sid });
    expect((await ls('order_refunded', lsOrder('1001', { status: 'refunded', refunded: true, refunded_amount: 2900 }))).body.result).toBe('refund updated');
    expect((await payment('ls_refund_1001')).amount).toBe(-2900);
  });

  it('ignores test mode', async () => {
    expect((await ls('order_created', lsOrder('1002'), { test: true })).body.result).toBe('test mode');
    expect(await payment('ls_order_1002')).toBeNull();
  });

  it('counts renewals, not the first subscription invoice, and stores subscription signals', async () => {
    const { vid } = await visit();
    await ls('order_created', lsOrder('1003', { customer_id: 88, user_email: 'bo@example.com' }), { custom: { rt_visitor_id: vid } });
    const sub = { type: 'subscriptions', id: '501', attributes: { status: 'active', order_id: 1003, customer_id: 88, product_name: 'Pro monthly', created_at: iso(), updated_at: iso(), renews_at: iso(Date.now() + 30 * 86_400_000) } };
    expect((await ls('subscription_created', sub)).body.result).toBe('linked');
    expect((await payment('ls_order_1003')).subscription_id).toBe('501');
    const row = await w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, '501').first<any>();
    expect(row).toMatchObject({ provider: 'lemonsqueezy', amount: 2900, interval: 'month', visitor_id: vid });

    const invoice = (id: string, reason: string) => ({ type: 'subscription-invoices', id, attributes: { subscription_id: 501, customer_id: 88, billing_reason: reason, total: 2900, currency: 'USD', status: 'paid', created_at: iso() } });
    expect((await ls('subscription_payment_success', invoice('9001', 'initial'))).body.result).toBe('first payment is the order');
    expect(await payment('ls_invoice_9001')).toBeNull();
    expect((await ls('subscription_payment_success', invoice('9002', 'renewal'))).body.result).toBe('recorded');
    expect(await payment('ls_invoice_9002')).toMatchObject({ renewal: 1, visitor_id: vid, matched_by: 'customer', subscription_id: '501', product: 'Pro license' });

    expect((await ls('subscription_cancelled', { ...sub, attributes: { ...sub.attributes, status: 'cancelled', cancelled: true, updated_at: iso(Date.now() + 1000) } })).body.result).toBe('cancellation');
    const signal = await w.db.prepare("SELECT * FROM subscription_signals WHERE site_id = ? AND provider = 'lemonsqueezy' AND type = 'cancellation'").bind(site.id).first<any>();
    expect(signal).toMatchObject({ visitor_id: vid });
    expect((await w.db.prepare('SELECT canceled_at FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, '501').first<any>()).canceled_at).toBeGreaterThan(0);
  });

  it('leaves an order that names another site to that site', async () => {
    expect((await ls('order_created', lsOrder('1004'), { custom: { rt_site_id: 'othersite' } })).body.result).toBe('other site');
    expect(await payment('ls_order_1004')).toBeNull();
  });
});

// ---------- Polar

// Polar's two keys: the secret's UTF-8 bytes (older endpoints), or the base64 after whsec_ (Standard Webhooks).
const polarKey = (secret: string, standard: boolean) => (standard ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8'));
function polarHeaders(body: string, secret = POLAR_SECRET, ts = now(), standard = false) {
  const id = uid('msg_');
  const sig = createHmac('sha256', polarKey(secret, standard)).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}`, 'content-type': 'application/json' };
}
async function polar(type: string, data: Record<string, unknown>, opts: { secret?: string; ts?: number; standard?: boolean; siteId?: string } = {}) {
  const body = JSON.stringify({ type, data });
  const res = await w.fetch(`/api/webhooks/polar/${opts.siteId ?? site.id}`, { method: 'POST', headers: polarHeaders(body, opts.secret, opts.ts, opts.standard), body });
  return { status: res.status, body: (await res.json()) as any };
}
const polarOrder = (id: string, over: Record<string, unknown> = {}) => ({
  id, created_at: iso(), modified_at: iso(), status: 'paid', paid: true, total_amount: 4900, refunded_amount: 0, currency: 'eur', billing_reason: 'purchase',
  customer_id: 'cus_p1', customer: { id: 'cus_p1', email: 'cy@example.com', name: 'Cy', metadata: {} }, product: { name: 'Polar plan' }, metadata: {}, ...over,
});

describe('Polar webhook', () => {
  it('checks the Standard Webhooks signature with the secret as it is', async () => {
    expect((await polar('order.paid', polarOrder('o0'), { secret: 'other' })).status).toBe(401);
    expect((await polar('order.paid', polarOrder('o0'), { ts: now() - 600 })).status).toBe(401);
  });

  it('accepts a whsec_ secret signed either way, as Polar signs endpoints made since September 2026', async () => {
    const secret = `whsec_${Buffer.from('polar standard webhooks key 0123').toString('base64')}`;
    const other = (await w.admin('/api/sites', { method: 'POST', json: { domain: 'polar-std.example', currency: 'EUR' } })).body;
    await w.admin(`/api/sites/${other.id}`, { method: 'PATCH', json: { polar_secret: secret } });
    forgetSite(other.id);
    expect((await polar('order.paid', polarOrder('std1'), { secret, standard: true, siteId: other.id })).body.result).toBe('recorded');
    expect((await polar('order.paid', polarOrder('std2'), { secret, standard: false, siteId: other.id })).body.result).toBe('recorded');
    expect((await polar('order.paid', polarOrder('std3'), { secret: 'whsec_b3RoZXI=', standard: true, siteId: other.id })).status).toBe(401);
  });

  it('records an order from metadata or the tracker\'s reference_id, once, and its refund', async () => {
    const a = await visit();
    expect((await polar('order.paid', polarOrder('o1', { metadata: { rt_visitor_id: a.vid, rt_session_id: a.sid } }))).body.result).toBe('recorded');
    expect(await payment('polar_order_o1')).toMatchObject({ provider: 'polar', amount: 4900, currency: 'EUR', visitor_id: a.vid, matched_by: 'metadata', product: 'Polar plan' });
    expect((await polar('order.paid', polarOrder('o1'))).body.result).toBe('already recorded');

    const b = await visit();
    await polar('order.paid', polarOrder('o2', { customer_id: 'cus_p2', customer: { id: 'cus_p2' }, metadata: { reference_id: `rtv_${b.vid}` } }));
    expect((await payment('polar_order_o2')).visitor_id).toBe(b.vid);

    expect((await polar('order.refunded', polarOrder('o1', { status: 'refunded', refunded_amount: 4900 }))).body.result).toBe('refund recorded');
    expect(await payment('polar_refund_o1')).toMatchObject({ kind: 'refund', amount: -4900, visitor_id: a.vid });
    expect((await polar('order.refunded', polarOrder('o1', { status: 'refunded', refunded_amount: 4900 }))).body.result).toBe('refund updated');
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE id = 'polar_refund_o1'")).toBe(1);
  });

  it('stores subscriptions and their signals', async () => {
    const subscription = {
      id: 'sub_p1', status: 'active', amount: 1200, currency: 'eur', recurring_interval: 'month', customer_id: 'cus_p1', created_at: iso(), modified_at: iso(),
      started_at: iso(), current_period_end: iso(Date.now() + 30 * 86_400_000), cancel_at_period_end: true, canceled_at: iso(), product: { name: 'Polar plan' }, metadata: {},
    };
    expect((await polar('subscription.canceled', subscription)).body.result).toBe('cancellation');
    expect(await w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, 'sub_p1').first<any>()).toMatchObject({ provider: 'polar', amount: 1200, interval: 'month' });
    expect(await count("SELECT COUNT(*) AS n FROM subscription_signals WHERE provider = 'polar' AND type = 'cancellation'")).toBe(1);
  });
});

// ---------- Paddle

const paddleSig = (body: string, secret = PADDLE_SECRET, ts = now()) => `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
async function paddle(event_type: string, data: Record<string, unknown>, opts: { secret?: string; ts?: number } = {}) {
  const body = JSON.stringify({ event_id: uid('evt_'), event_type, occurred_at: iso(), data });
  const res = await w.fetch(`/api/webhooks/paddle/${site.id}`, { method: 'POST', headers: { 'paddle-signature': paddleSig(body, opts.secret, opts.ts), 'content-type': 'application/json' }, body });
  return { status: res.status, body: (await res.json()) as any };
}
const txn = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'completed', origin: 'web', customer_id: 'ctm_1', subscription_id: null, currency_code: 'USD', billed_at: iso(), created_at: iso(),
  details: { totals: { total: '1500', grand_total: '1500', currency_code: 'USD' }, line_items: [{ product: { name: 'Paddle plan' } }] }, ...over,
});

describe('Paddle webhook', () => {
  it('checks Paddle-Signature', async () => {
    expect((await paddle('transaction.completed', txn('txn_0'), { secret: 'pdl_wrong' })).status).toBe(401);
    expect((await paddle('transaction.completed', txn('txn_0'), { ts: now() - 400 })).status).toBe(401);
  });

  it('records a transaction from custom_data once, and approved refunds only', async () => {
    const { vid } = await visit();
    expect((await paddle('transaction.completed', txn('txn_1', { custom_data: { rt_visitor_id: vid } }))).body.result).toBe('recorded');
    expect(await payment('paddle_txn_1')).toMatchObject({ provider: 'paddle', amount: 1500, visitor_id: vid, matched_by: 'metadata', product: 'Paddle plan' });
    expect((await paddle('transaction.completed', txn('txn_1'))).body.result).toBe('already recorded');

    const adj = (status: string) => ({ id: 'adj_1', action: 'refund', status, transaction_id: 'txn_1', currency_code: 'USD', totals: { total: '500' }, created_at: iso(), updated_at: iso() });
    expect((await paddle('adjustment.created', adj('pending_approval'))).body.result).toBe('pending');
    expect(await payment('paddle_adj_1')).toBeNull();
    expect((await paddle('adjustment.updated', adj('approved'))).body.result).toBe('refund recorded');
    expect(await payment('paddle_adj_1')).toMatchObject({ kind: 'refund', amount: -500, visitor_id: vid });
    expect((await paddle('adjustment.updated', adj('reversed'))).body.result).toBe('refund reversed');
    expect(await payment('paddle_adj_1')).toBeNull();
  });

  it('marks subscription renewals and stores the subscription', async () => {
    const sub = {
      id: 'sub_pd1', status: 'trialing', customer_id: 'ctm_1', currency_code: 'USD', created_at: iso(), updated_at: iso(), started_at: iso(),
      items: [{ quantity: 1, price: { unit_price: { amount: '1500', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 } }, trial_dates: { starts_at: iso(), ends_at: iso(Date.now() + 7 * 86_400_000) }, product: { name: 'Paddle plan' } }],
    };
    expect((await paddle('subscription.created', sub)).body.result).toBe('trial_start');
    expect(await w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, 'sub_pd1').first<any>()).toMatchObject({ provider: 'paddle', amount: 1500, interval: 'month' });
    await paddle('transaction.completed', txn('txn_2', { subscription_id: 'sub_pd1', origin: 'subscription_recurring' }));
    expect(await payment('paddle_txn_2')).toMatchObject({ renewal: 1, subscription_id: 'sub_pd1' });
  });
});

// ---------- Gumroad

const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
async function gumroad(f: Record<string, string>, token = site.gumroad_token) {
  const res = await w.fetch(`/api/webhooks/gumroad/${site.id}/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(f) });
  return { status: res.status, body: (await res.json()) as any };
}
const sale = (id: string, over: Record<string, string> = {}) => ({
  seller_id: 'seller_abc123', sale_id: id, sale_timestamp: iso(), price: '1000', currency: 'usd', email: 'dee@example.com', full_name: 'Dee',
  product_name: 'Ebook', purchaser_id: 'pur_1', test: 'false', refunded: 'false', ...over,
});

describe('Gumroad ping', () => {
  it('needs the token from the URL and the saved seller id', async () => {
    expect((await gumroad(sale('g0'), 'wrongtoken12345678')).status).toBe(401);
    expect((await gumroad(sale('g0', { seller_id: 'someone_else' }))).status).toBe(401);
    expect((await gumroad({ ...sale('g0'), seller_id: '' })).status).toBe(401);
  });

  it('records a sale from url_params once, skips test sales, and records refunds', async () => {
    const { vid } = await visit();
    expect((await gumroad(sale('g1', { 'url_params[rt_visitor_id]': vid }))).body.result).toBe('recorded');
    expect(await payment('gumroad_g1')).toMatchObject({ provider: 'gumroad', amount: 1000, currency: 'USD', visitor_id: vid, matched_by: 'metadata', product: 'Ebook' });
    expect((await gumroad(sale('g1'))).body.result).toBe('already recorded');
    expect((await gumroad(sale('g2', { test: 'true' }))).body.result).toBe('test mode');
    expect(await payment('gumroad_g2')).toBeNull();
    expect((await gumroad(sale('g1', { resource_name: 'refund', refunded: 'true' }))).body.result).toBe('refund recorded');
    expect(await payment('gumroad_refund_g1')).toMatchObject({ kind: 'refund', amount: -1000, visitor_id: vid });
  });

  it('tracks subscriptions; a cancellation needs only the token', async () => {
    await gumroad(sale('g3', { subscription_id: 'gsub_1', recurrence: 'monthly', price: '500' }));
    await gumroad(sale('g4', { subscription_id: 'gsub_1', recurrence: 'monthly', price: '500', is_recurring_charge: 'true' }));
    expect((await payment('gumroad_g4')).renewal).toBe(1);
    expect(await w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, 'gsub_1').first<any>()).toMatchObject({ amount: 500, interval: 'month' });
    const cancel = { resource_name: 'cancellation', subscription_id: 'gsub_1', cancelled: 'true', cancelled_at: iso(), product_name: 'Ebook' };
    expect((await gumroad(cancel)).body.result).toBe('cancellation');
  });

  it('saves the seller id from the first sale when none was typed in', async () => {
    const other = await w.createSite({ domain: 'gum.example', gumroad_new_token: true });
    expect(other.gumroad_seller_id).toBeNull();
    const ping = (f: Record<string, string>) =>
      w.fetch(`/api/webhooks/gumroad/${other.id}/${other.gumroad_token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(f) });
    expect((await ping(sale('gx1', { seller_id: 'seller_first' }))).status).toBe(200);
    expect((await w.admin(`/api/sites/${other.id}`)).body.gumroad_seller_id).toBe('seller_first');
    expect((await ping(sale('gx2', { seller_id: 'seller_second' }))).status).toBe(401);
    const off = await w.admin(`/api/sites/${other.id}`, { method: 'PATCH', json: { gumroad_token: '' } });
    forgetSite(other.id);
    expect(off.body).toMatchObject({ gumroad_token: null, gumroad_seller_id: null });
    expect((await ping(sale('gx3', { seller_id: 'seller_first' }))).status).toBe(400);
  });

  it('a new token turns the old URL off', async () => {
    const old = site.gumroad_token;
    const res = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { gumroad_new_token: true } });
    forgetSite(site.id);
    expect(res.body.gumroad_token).not.toBe(old);
    expect((await gumroad(sale('g5'), old)).status).toBe(401);
    site.gumroad_token = res.body.gumroad_token;
    expect((await gumroad(sale('g5'))).status).toBe(200);
  });
});

// ---------- other revenue

describe('POST /api/v1/payments with kind income', () => {
  it('adds revenue but no customer, payment or visitor', async () => {
    const shop = await w.createSite({ domain: 'blog.example' });
    const post = (json: unknown) => w.fetch('/api/v1/payments', { method: 'POST', json, headers: { authorization: `Bearer ${shop.api_key}` } });
    const { vid } = await visit(shop.id);
    expect((await post({ transaction_id: 'adsense-2026-10', amount: 412.5, currency: 'USD', kind: 'income', product: 'AdSense', visitor_id: vid })).status).toBe(200);
    expect((await post({ transaction_id: 'sale_1', amount: 20, currency: 'USD', visitor_id: vid, product: 'Course' })).status).toBe(200);
    expect((await post({ transaction_id: 'x', amount: 1, kind: 'gift' })).status).toBe(400);
    expect(await payment(`${shop.id}:adsense-2026-10`)).toMatchObject({ provider: 'income', kind: 'income', amount: 41250, visitor_id: null, product: 'AdSense' });
    expect((await payment(`${shop.id}:sale_1`)).product).toBe('Course');
    const overview = (await w.admin(`/api/sites/${shop.id}/overview?period=7d`)).body;
    expect(overview.current.revenue).toBe(43250);
    expect(overview.current.payments).toBe(1);
    expect(overview.current.customers).toBe(1);
    const lines = (await w.admin(`/api/sites/${shop.id}/revenue?period=7d`)).body;
    expect(lines.find((l: any) => l.provider === 'income')).toMatchObject({ gross: 41250, net: 41250, payments: 0 });
  });
});

// ---------- Stripe history import

describe('Stripe history import', () => {
  let shop: any;
  const days = (n: number) => now() - n * 86_400;
  const charge = (id: string, over: Record<string, unknown> = {}) => ({
    id, object: 'charge', livemode: true, status: 'succeeded', paid: true, captured: true, amount: 2000, amount_captured: 2000, amount_refunded: 0,
    currency: 'usd', created: days(10), customer: 'cus_imp', billing_details: { email: 'eve@example.com' }, metadata: {}, invoice: null, payment_intent: null, refunds: { data: [] }, ...over,
  });
  // Newest first, like Stripe.
  const all = [
    charge('ch_inv', { created: days(2), payment_intent: 'pi_inv', invoice: { id: 'in_1', subscription: 'sub_s1', billing_reason: 'subscription_cycle', amount_paid: 2000, currency: 'usd', customer: 'cus_imp', customer_email: 'eve@example.com', payment_intent: 'pi_inv', charge: 'ch_inv' } }),
    charge('ch_hooked', { created: days(3), payment_intent: 'pi_hooked' }),
    charge('ch_test', { created: days(4), livemode: false }),
    charge('ch_failed', { created: days(5), status: 'failed', paid: false }),
    charge('ch_legacy', { created: days(6), amount_refunded: 500, refunds: { data: [{ id: 're_1', amount: 500, status: 'succeeded', created: days(5) }] } }),
    ...Array.from({ length: 30 }, (_, i) => charge(`ch_old${i}`, { created: days(20 + i), payment_intent: `pi_old${i}`, customer: `cus_o${i}`, billing_details: {} })),
  ];
  const calls: URL[] = [];
  const stripeApi = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    if (new Headers(init?.headers).get('authorization') !== 'Bearer rk_live_goodkey1234567890') return Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 });
    const after = url.searchParams.get('starting_after');
    const since = Number(url.searchParams.get('created[gte]'));
    const list = all.filter((c) => c.created >= since);
    const start = after ? list.findIndex((c) => c.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get('limit'));
    return Response.json({ object: 'list', data: list.slice(start, start + limit), has_more: start + limit < list.length });
  }) as typeof fetch;

  beforeAll(async () => {
    shop = await w.createSite({ domain: 'saas.example', stripe_webhook_secret: STRIPE_SECRET });
    // The webhook stored this one before the import.
    const body = JSON.stringify({ id: 'evt_h', type: 'payment_intent.succeeded', created: days(3), data: { object: { id: 'pi_hooked', amount_received: 2000, currency: 'usd', latest_charge: 'ch_hooked' } } });
    const t = now();
    await w.fetch(`/api/webhooks/stripe/${shop.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', STRIPE_SECRET).update(`${t}.${body}`).digest('hex')}` },
      body,
    });
  });

  it('refuses test and non-restricted keys', async () => {
    expect((await w.admin(`/api/sites/${shop.id}/stripe-import`, { method: 'POST', json: { key: 'rk_test_abcdefghijkl' } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${shop.id}/stripe-import`, { method: 'POST', json: { key: 'sk_live_abcdefghijkl' } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${shop.id}/stripe-import`, { method: 'POST', json: { key: 'rk_live_goodkey1234567890', months: 99 } })).status).toBe(400);
  });

  it('pages through the charges in bounded steps, resumable, without double counting', async () => {
    const global = globalThis.fetch;
    // Stripe answers through the mock; the exchange-rate API keeps the helper's mock.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://api.stripe.com/') ? stripeApi(input, init) : global(input, init)) as typeof fetch;
    try {
      const started = await w.admin(`/api/sites/${shop.id}/stripe-import`, { method: 'POST', json: { key: 'rk_live_goodkey1234567890', months: 1 } });
      expect(started.status).toBe(200);
      expect(started.body.stripe_key).toBeUndefined();
      let state = started.body;
      let steps = 1;
      while (state.status === 'running' && steps < 50) {
        state = (await w.admin(`/api/sites/${shop.id}/stripe-import/step`, { method: 'POST' })).body;
        steps++;
      }
      expect(state).toMatchObject({ status: 'done', progress: 1, error: null });
      // 1 month back: ch_old0..ch_old10 are within 30 days (20 to 30 days old).
      const inRange = all.filter((c) => c.created >= now() - 31 * 86_400);
      expect(state.seen).toBe(inRange.length);
      expect(steps).toBeGreaterThan(1);
      expect(calls[0].searchParams.getAll('expand[]')).toEqual(['data.invoice', 'data.refunds']);
      expect(calls.slice(1).every((u) => !!u.searchParams.get('starting_after'))).toBe(true);
    } finally {
      globalThis.fetch = global;
    }
    const row = await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(shop.id).first<any>();
    expect(row.stripe_key).toBeNull();

    // The invoice charge is keyed by its PaymentIntent, with the invoice's subscription and renewal.
    expect(await payment('pi_inv')).toMatchObject({ provider: 'stripe', amount: 2000, subscription_id: 'sub_s1', renewal: 1, customer_id: 'cus_imp' });
    // Stored by the webhook already: still one row.
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE id IN ('pi_hooked', 'ch_hooked')")).toBe(1);
    expect(await payment('ch_test')).toBeNull();
    expect(await payment('ch_failed')).toBeNull();
    expect(await payment('ch_legacy')).toMatchObject({ amount: 2000 });
    expect(await payment('stripe_refund_ch_legacy')).toMatchObject({ kind: 'refund', amount: -500 });
    expect(await payment('pi_old0')).not.toBeNull();
    expect(await payment('pi_old29')).toBeNull();
    const before = await count('SELECT COUNT(*) AS n FROM payments WHERE site_id = ?', shop.id);

    // Running it again stores nothing new.
    await w.db.prepare("UPDATE stripe_imports SET status = 'running', stripe_key = 'rk_live_goodkey1234567890', cursor = NULL, cursor_ts = NULL WHERE site_id = ?").bind(shop.id).run();
    let again: any;
    do again = await importStep(w.db, shop, stripeApi);
    while (again.status === 'running');
    expect(await count('SELECT COUNT(*) AS n FROM payments WHERE site_id = ?', shop.id)).toBe(before);
  });

  it('keeps each step under the free plan\'s 50 D1 queries per request', async () => {
    const fresh = await w.createSite({ domain: 'fresh.example', stripe_webhook_secret: STRIPE_SECRET });
    let queries = 0;
    const counted = new Proxy(w.db, {
      get(target, k) {
        if (k === 'batch') return (stmts: D1PreparedStatement[]) => (queries++, target.batch(stmts));
        if (k !== 'prepare') return Reflect.get(target, k);
        const wrap = (st: any): any => ({
          inner: st.inner ?? st,
          bind: (...a: unknown[]) => wrap(st.bind(...a)),
          first: (c?: string) => (queries++, st.first(c)),
          all: () => (queries++, st.all()),
          run: () => (queries++, st.run()),
        });
        return (sql: string) => wrap(target.prepare(sql));
      },
    });
    await w.db.prepare(
      "INSERT INTO stripe_imports (site_id, stripe_key, status, since, started_at, updated_at) VALUES (?, 'rk_live_goodkey1234567890', 'running', ?, ?, ?)",
    ).bind(fresh.id, Date.now() - 40 * 86_400_000, Date.now(), Date.now()).run();
    let state: any;
    let steps = 0;
    do {
      queries = 0;
      state = await importStep(counted as D1Database, fresh, stripeApi);
      steps++;
      expect(queries).toBeLessThanOrEqual(50);
    } while (state.status === 'running' && steps < 60);
    expect(state.status).toBe('done');
  });

  it('fails on a refused key, forgets it, and can be canceled', async () => {
    await w.db.prepare("UPDATE stripe_imports SET status = 'running', stripe_key = 'rk_live_revokedkey123456' WHERE site_id = ?").bind(shop.id).run();
    const failed = await importStep(w.db, shop, stripeApi);
    expect(failed).toMatchObject({ status: 'failed', error: 'Invalid API Key provided' });
    expect((await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(shop.id).first<any>()).stripe_key).toBeNull();

    await w.db.prepare("UPDATE stripe_imports SET status = 'running', stripe_key = 'rk_live_goodkey1234567890' WHERE site_id = ?").bind(shop.id).run();
    const canceled = await w.admin(`/api/sites/${shop.id}/stripe-import`, { method: 'DELETE' });
    expect(canceled.body.status).toBe('canceled');
    expect((await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(shop.id).first<any>()).stripe_key).toBeNull();
  });
});

// ---------- tracker link tagging

describe('tracker: Lemon Squeezy, Polar and Gumroad links', () => {
  const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
  const IDS = { vid: '0123456789abcdef0123456789abcdef', sid: 'fedcba9876543210fedcba9876543210' };

  function load(links: { href: string }[]) {
    const window: any = {
      location: new URL('https://example.com/pricing'),
      navigator: { webdriver: false },
      screen: { width: 1440 },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
    };
    const document = {
      cookie: '',
      currentScript: { src: 'https://stats.example/js/script.js', getAttribute: (n: string) => (n === 'data-website-id' ? 'site123' : null), hasAttribute: () => false },
      referrer: '',
      visibilityState: 'visible',
      readyState: 'complete',
      documentElement: {},
      addEventListener() {},
      querySelectorAll: () => links,
    };
    const fetch = async (_u: string, init: RequestInit) => (JSON.parse(String(init.body)).vid ? new Response(null, { status: 202 }) : Response.json(IDS, { status: 202 }));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    vm.runInContext(CODE, vm.createContext({ window, document, localStorage: storage, fetch, screen: window.screen, crypto: globalThis.crypto, URL, URLSearchParams, Blob, Response, setTimeout, setInterval: () => 0 }));
  }

  it('adds the visitor to each checkout link and keeps the site\'s own reference_id', async () => {
    const links = [
      { href: 'https://acme.lemonsqueezy.com/checkout/buy/abc-123' },
      { href: 'https://buy.polar.sh/polar_cl_abc' },
      { href: 'https://buy.polar.sh/polar_cl_def?reference_id=order_9' },
      { href: 'https://gumroad.com/l/ebook' },
      { href: 'https://acme.gumroad.com/l/course' },
      { href: 'https://gumroad.com/discover' },
      { href: 'https://acme.lemonsqueezy.com/' },
    ];
    load(links);
    await new Promise((r) => setTimeout(r, 80));
    const ls = new URL(links[0].href).searchParams;
    expect(ls.get('checkout[custom][rt_visitor_id]')).toBe(IDS.vid);
    expect(ls.get('checkout[custom][rt_session_id]')).toBe(IDS.sid);
    expect(ls.get('checkout[custom][rt_site_id]')).toBe('site123');
    expect(links[1].href).toBe(`https://buy.polar.sh/polar_cl_abc?reference_id=rtv_${IDS.vid}`);
    expect(links[2].href).toBe('https://buy.polar.sh/polar_cl_def?reference_id=order_9');
    expect(new URL(links[3].href).searchParams.get('rt_visitor_id')).toBe(IDS.vid);
    expect(new URL(links[4].href).searchParams.get('rt_session_id')).toBe(IDS.sid);
    expect(links[5].href).toBe('https://gumroad.com/discover');
    expect(links[6].href).toBe('https://acme.lemonsqueezy.com/');
  });
});
