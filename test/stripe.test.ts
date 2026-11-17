import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../src/worker/lib/crypto';
import { refundedOnCharge, stripeToMinor } from '../src/worker/stripe';
import { startWorker, type TestWorker } from './helpers/worker';

const SECRET = 'whsec_test_0123456789abcdefABCDEF';
const sign = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('Stripe-Signature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a valid signature, also next to an old one', async () => {
    expect(await verifyStripeSignature(body, sign(body), SECRET)).toBe(true);
    const t = Math.floor(Date.now() / 1000);
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')},v0=ignored`;
    expect(await verifyStripeSignature(body, header, SECRET)).toBe(true);
  });
  it('rejects tampering, other secrets, old timestamps and junk', async () => {
    expect(await verifyStripeSignature(body + ' ', sign(body), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body, 'whsec_other'), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 301), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body, SECRET, Math.floor(Date.now() / 1000) + 301), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, null, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, 't=,v1=', SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000)}`, SECRET)).toBe(false);
  });
});

describe('Stripe amounts', () => {
  it('handles zero-decimal and three-decimal currencies', () => {
    expect(stripeToMinor(1999, 'eur')).toBe(1999);
    expect(stripeToMinor(1200, 'JPY')).toBe(1200);
    expect(stripeToMinor(1500, 'KWD')).toBe(1500);
    // Stripe keeps two decimals for ISK, which has none.
    expect(stripeToMinor(990000, 'ISK')).toBe(9900);
  });
});

describe('POST /api/webhooks/stripe/:siteId', () => {
  let w: TestWorker;
  let site: any;
  let n = 0;
  const id = (p: string) => `${p}_${++n}${Math.random().toString(36).slice(2, 8)}`;
  const deliver = async (type: string, object: Record<string, unknown>, opts: { secret?: string; siteId?: string; created?: number } = {}) => {
    const body = JSON.stringify({ id: id('evt'), object: 'event', type, created: opts.created ?? Math.floor(Date.now() / 1000), data: { object } });
    const res = await w.fetch(`/api/webhooks/stripe/${opts.siteId ?? site.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': sign(body, opts.secret ?? SECRET), 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const payment = (pid: string) => w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(pid).first<any>();
  const visit = async (source: string) => {
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://example.org/?ref=${source}`, r: '', vid, sid }),
    });
    return { vid, sid };
  };

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'example.org', stripe_webhook_secret: SECRET });
  });
  afterAll(() => w.dispose());

  it('masks the secret, validates its format, and checks signatures', async () => {
    expect(site.stripe_webhook_secret).toBe('••••••••');
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { stripe_webhook_secret: 'sk_live_oops' } })).status).toBe(400);
    expect((await deliver('invoice.paid', {}, { secret: 'whsec_wrong' })).status).toBe(401);
    const plain = await w.createSite();
    expect((await deliver('invoice.paid', {}, { siteId: plain.id })).status).toBe(400);
    expect((await deliver('invoice.paid', {}, { siteId: 'nope' })).status).toBe(404);
    expect((await deliver('customer.created', {})).body).toEqual({ ok: true, result: 'ignored' });
  });

  it('records a Checkout payment once, credited through metadata', async () => {
    const v = await visit('tiktok-3');
    const pi = id('pi');
    const cs = { id: id('cs'), object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 4900, currency: 'eur', payment_intent: pi, customer: 'cus_A', customer_details: { email: 'Ann@Example.com', name: 'Ann' }, metadata: { ml_visitor_id: v.vid, ml_session_id: v.sid, ml_site_id: site.id } };
    expect((await deliver('checkout.session.completed', cs)).body.result).toBe('recorded');
    // The same payment's PaymentIntent event: no second row.
    await deliver('payment_intent.succeeded', { id: pi, object: 'payment_intent', amount_received: 4900, currency: 'eur', customer: 'cus_A', metadata: {} });
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE id = ?').bind(pi).first<any>()).n).toBe(1);
    expect(await payment(pi)).toMatchObject({ provider: 'stripe', amount: 4900, currency: 'EUR', visitor_id: v.vid, session_id: v.sid, matched_by: 'metadata', email: 'ann@example.com', renewal: 0 });
  });

  it('records a SEPA Direct Debit checkout when the delayed payment succeeds, not when the session completes unpaid', async () => {
    const v = await visit('meta-ad');
    const pi = id('pi');
    const cs = { id: id('cs'), mode: 'payment', payment_status: 'unpaid', amount_total: 4999, currency: 'eur', payment_intent: pi, customer_details: { email: 'sepa@example.com' }, metadata: { rt_visitor_id: v.vid } };
    expect((await deliver('checkout.session.completed', cs)).body.result).toBe('not paid');
    expect(await payment(pi)).toBeNull();
    expect((await deliver('checkout.session.async_payment_succeeded', { ...cs, payment_status: 'paid' })).body.result).toBe('recorded');
    expect(await payment(pi)).toMatchObject({ amount: 4999, visitor_id: v.vid, matched_by: 'metadata', email: 'sepa@example.com' });
  });

  it('fills in the visitor when the PaymentIntent arrives before Checkout', async () => {
    const v = await visit('newsletter-7');
    const pi = id('pi');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 1500, currency: 'eur', customer: id('cus'), metadata: {} });
    expect((await payment(pi)).visitor_id).toBeNull();
    await deliver('checkout.session.completed', { id: id('cs'), mode: 'payment', payment_status: 'paid', amount_total: 1500, currency: 'eur', payment_intent: pi, metadata: { rt_visitor_id: v.vid } });
    expect(await payment(pi)).toMatchObject({ visitor_id: v.vid, session_id: v.sid, matched_by: 'metadata' });
  });

  it.each(['rtv_', 'mlv_'])('links Payment Links through client_reference_id %s<visitor id>', async (prefix) => {
    const v = await visit('reddit-post');
    const pi = id('pi');
    await deliver('checkout.session.completed', { id: id('cs'), mode: 'payment', payment_status: 'paid', amount_total: 900, currency: 'eur', payment_intent: pi, client_reference_id: `${prefix}${v.vid}`, metadata: {} });
    expect((await payment(pi)).visitor_id).toBe(v.vid);
  });

  it('subscriptions: first invoice, renewal with no metadata, in either order', async () => {
    const v = await visit('podcast-12');
    const sub = id('sub'), cus = id('cus');
    // Checkout first (subscription metadata not set by the site), then the first invoice.
    await deliver('checkout.session.completed', { id: id('cs'), mode: 'subscription', payment_status: 'paid', amount_total: 1900, currency: 'eur', subscription: sub, customer: cus, metadata: { ml_visitor_id: v.vid } });
    const first = id('pi');
    await deliver('invoice.paid', { id: id('in'), amount_paid: 1900, currency: 'eur', customer: cus, customer_email: 'sub@example.com', billing_reason: 'subscription_create', subscription: sub, payment_intent: first });
    expect(await payment(first)).toMatchObject({ visitor_id: v.vid, session_id: v.sid, matched_by: 'metadata', renewal: 0, subscription_id: sub });
    // New API shape (2025-03-31): subscription and PaymentIntent under parent / payments.
    const second = id('pi');
    await deliver('invoice.paid', {
      id: id('in'), amount_paid: 1900, currency: 'eur', customer: cus, billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: sub, metadata: {} } },
      payments: { data: [{ payment: { payment_intent: second } }] },
    });
    expect(await payment(second)).toMatchObject({ visitor_id: v.vid, renewal: 1 });
    // Its PaymentIntent is skipped (recorded by the invoice).
    expect((await deliver('payment_intent.succeeded', { id: second, amount_received: 1900, currency: 'eur', description: 'Subscription update' })).body.result).toBe('invoice payment');
    expect((await deliver('payment_intent.succeeded', { id: id('pi'), amount_received: 1900, currency: 'eur', invoice: 'in_x' })).body.result).toBe('invoice payment');

    // Other order: invoice first (unlinked), then Checkout links it.
    const v2 = await visit('youtube-1');
    const sub2 = id('sub'), pi2 = id('pi');
    await deliver('invoice.paid', { id: id('in'), amount_paid: 2900, currency: 'eur', customer: id('cus'), billing_reason: 'subscription_create', subscription: sub2, payment_intent: pi2 });
    expect((await payment(pi2)).visitor_id).toBeNull();
    await deliver('checkout.session.completed', { id: id('cs'), mode: 'subscription', payment_status: 'paid', subscription: sub2, metadata: { ml_visitor_id: v2.vid } });
    expect(await payment(pi2)).toMatchObject({ visitor_id: v2.vid, session_id: v2.sid, matched_by: 'metadata' });
  });

  it('falls back to the email of an identified visitor', async () => {
    const v = await visit('linkedin');
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129 Safari/537.36' },
      body: JSON.stringify({ w: site.id, t: 'identify', u: 'https://example.org/app', p: { email: 'known@example.com' }, vid: v.vid, sid: v.sid }),
    });
    const pi = id('pi');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 2500, currency: 'eur', receipt_email: 'Known@Example.com', metadata: {} });
    expect(await payment(pi)).toMatchObject({ visitor_id: v.vid, matched_by: 'email' });
  });

  it('refunds: one row per charge holding the total refunded so far', async () => {
    const v = await visit('refund-test');
    const pi = id('pi'), ch = id('ch');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 10000, currency: 'eur', metadata: { ml_visitor_id: v.vid } });
    await deliver('charge.refunded', { id: ch, payment_intent: pi, amount_refunded: 3000, currency: 'eur' });
    await deliver('charge.refunded', { id: ch, payment_intent: pi, amount_refunded: 10000, currency: 'eur' });
    expect(await payment(`stripe_refund_${ch}`)).toMatchObject({ kind: 'refund', amount: -10000, visitor_id: v.vid, session_id: v.sid });
    const net = await w.db.prepare('SELECT SUM(amount) AS s FROM payments WHERE id IN (?, ?)').bind(pi, `stripe_refund_${ch}`).first<any>();
    expect(net.s).toBe(0);
    expect((await deliver('charge.refunded', { id: id('ch'), payment_intent: 'pi_unknown', amount_refunded: 500, currency: 'eur' })).body.result).toBe('no payment');
  });

  it('ignores events another site claimed through rt_site_id or ml_site_id, and unpaid sessions', async () => {
    const pi = id('pi');
    expect((await deliver('payment_intent.succeeded', { id: pi, amount_received: 100, currency: 'eur', metadata: { ml_site_id: 'other-site' } })).body.result).toBe('other site');
    expect(await payment(pi)).toBeNull();
    const pi2 = id('pi');
    expect((await deliver('payment_intent.succeeded', { id: pi2, amount_received: 100, currency: 'eur', metadata: { rt_site_id: 'other-site' } })).body.result).toBe('other site');
    expect(await payment(pi2)).toBeNull();
    expect((await deliver('checkout.session.completed', { id: id('cs'), mode: 'payment', payment_status: 'unpaid', amount_total: 100, currency: 'eur' })).body.result).toBe('not paid');
  });

  it('payments and goals API: new keys start with rt_, and rt_* or ml_* visitor keys work like visitor_id', async () => {
    expect(site.api_key).toMatch(/^rt_/);
    const v = await visit('api-key-check');
    const call = (path: string, json: unknown) =>
      w.fetch(path, { method: 'POST', headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' }, body: JSON.stringify(json) });
    const txn = id('txn');
    const res = await call('/api/v1/payments', { transaction_id: txn, amount: 12.5, currency: 'EUR', rt_visitor_id: v.vid });
    expect(((await res.json()) as any).visitor_id).toBe(v.vid);
    expect(await payment(`${site.id}:${txn}`)).toMatchObject({ visitor_id: v.vid, amount: 1250 });
    expect((await call('/api/v1/goals', { ml_visitor_id: v.vid, name: 'api_goal' })).status).toBe(200);
  });

  it('stores zero-decimal currencies as they are', async () => {
    const pi = id('pi');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 1200, currency: 'jpy' });
    expect(await payment(pi)).toMatchObject({ amount: 1200, currency: 'JPY' });
  });

  it('stores a payment in another currency converted to the site currency', async () => {
    const pi = id('pi');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 4900, currency: 'eur' });
    // The site counts in USD; 49.00 EUR at 1.25 USD per EUR.
    expect(await payment(pi)).toMatchObject({ amount: 4900, currency: 'EUR', amount_conv: 6125 });
  });
  const rows = (like: string) => w.db.prepare('SELECT id, amount, kind FROM payments WHERE id LIKE ? ORDER BY id').bind(like).all<any>().then((r) => r.results);
  const sumOf = async (...ids: string[]) =>
    (await w.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first<any>()).s;

  it('disputes: a lost one subtracts once, a won one does not, a late open event changes nothing', async () => {
    const pi = id('pi'), ch = id('ch'), lost = id('dp'), won = id('dp');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 5000, currency: 'eur', latest_charge: ch });
    const dispute = (dp: string, status: string) => ({ id: dp, object: 'dispute', amount: 5000, currency: 'eur', charge: ch, payment_intent: pi, status });
    expect((await deliver('charge.dispute.created', dispute(lost, 'needs_response'))).body.result).toBe('dispute open');
    expect(await payment(`stripe_dispute_${lost}`)).toBeNull();
    expect((await deliver('charge.dispute.closed', dispute(lost, 'lost'))).body.result).toBe('dispute lost');
    await deliver('charge.dispute.closed', dispute(lost, 'lost'));
    // Stripe retried the old open event after the close: still lost.
    expect((await deliver('charge.dispute.updated', dispute(lost, 'needs_response'))).body.result).toBe('dispute already closed');
    expect(await payment(`stripe_dispute_${lost}`)).toMatchObject({ kind: 'refund', amount: -5000, currency: 'EUR' });
    expect(await sumOf(pi, `stripe_dispute_${lost}`)).toBe(0);

    const pi2 = id('pi');
    await deliver('payment_intent.succeeded', { id: pi2, amount_received: 3000, currency: 'eur' });
    const d2 = { id: won, amount: 3000, currency: 'eur', charge: id('ch'), payment_intent: pi2 };
    await deliver('charge.dispute.funds_withdrawn', { ...d2, status: 'under_review' });
    expect((await deliver('charge.dispute.closed', { ...d2, status: 'won' })).body.result).toBe('dispute won');
    await deliver('charge.dispute.funds_reinstated', { ...d2, status: 'won' });
    expect(await payment(`stripe_dispute_${won}`)).toBeNull();
    expect(await sumOf(pi2)).toBe(3000);
    expect((await deliver('charge.dispute.closed', { ...d2, id: id('dp'), payment_intent: 'pi_unknown', charge: 'ch_unknown', status: 'lost' })).body.result).toBe('no payment');
  }, 60_000);

  it('refunds: a failed or canceled refund comes back, with or without refund.* events', async () => {
    // Endpoint with refund.* events: charge.refunded and refund.created describe the same refund once.
    const pi = id('pi'), ch = id('ch'), re = id('re');
    await deliver('payment_intent.succeeded', { id: pi, amount_received: 8000, currency: 'eur' });
    await deliver('charge.refunded', { id: ch, payment_intent: pi, amount_refunded: 8000, currency: 'eur' });
    await deliver('refund.created', { id: re, object: 'refund', amount: 8000, currency: 'eur', charge: ch, payment_intent: pi, status: 'pending' });
    expect(await sumOf(pi, `stripe_refund_${ch}`)).toBe(0);
    expect((await deliver('refund.failed', { id: re, object: 'refund', amount: 8000, currency: 'eur', charge: ch, payment_intent: pi, status: 'failed' })).body.result).toBe('refund reversed');
    expect(await payment(`stripe_refund_${ch}`)).toBeNull();
    // A retried older event does not bring the failed refund back, whether or not Stripe lowered amount_refunded.
    await deliver('refund.updated', { id: re, amount: 8000, currency: 'eur', charge: ch, payment_intent: pi, status: 'succeeded' });
    await deliver('charge.refunded', { id: ch, payment_intent: pi, amount_refunded: 8000, currency: 'eur' });
    expect(await sumOf(pi, `stripe_refund_${ch}`)).toBe(8000);

    // Endpoint with only charge.refunded and refund.updated (the old event list plus one): a canceled refund comes back.
    const pi2 = id('pi'), ch2 = id('ch'), a = id('re'), b = id('re');
    await deliver('payment_intent.succeeded', { id: pi2, amount_received: 10000, currency: 'eur' });
    await deliver('charge.refunded', { id: ch2, payment_intent: pi2, amount_refunded: 3000, currency: 'eur' });
    await deliver('charge.refunded', { id: ch2, payment_intent: pi2, amount_refunded: 5000, currency: 'eur' });
    expect(await sumOf(pi2, `stripe_refund_${ch2}`)).toBe(5000);
    await deliver('charge.refund.updated', { id: b, amount: 2000, currency: 'eur', charge: ch2, payment_intent: pi2, status: 'canceled' }, { created: Math.floor(Date.now() / 1000) + 60 });
    expect(await sumOf(pi2, `stripe_refund_${ch2}`)).toBe(7000);
    // Older API versions list the refunds on the charge.
    const pi3 = id('pi'), ch3 = id('ch');
    await deliver('payment_intent.succeeded', { id: pi3, amount_received: 4000, currency: 'eur' });
    await deliver('charge.refunded', { id: ch3, payment_intent: pi3, amount_refunded: 4000, currency: 'eur', refunds: { data: [{ id: a, amount: 4000, charge: ch3, status: 'succeeded' }] } });
    await deliver('refund.failed', { id: a, amount: 4000, currency: 'eur', charge: ch3, payment_intent: pi3, status: 'failed' });
    expect(await sumOf(pi3, `stripe_refund_${ch3}`)).toBe(4000);
  }, 60_000);

  it('refundedOnCharge: refund objects decide once they account for amount_refunded', () => {
    expect(refundedOnCharge(null, [{ amount: 500, status: 'succeeded', at: 1 }])).toBe(500);
    expect(refundedOnCharge({ amount: 500, at: 1 }, [])).toBe(500);
    expect(refundedOnCharge({ amount: 500, at: 1 }, [{ amount: 500, status: 'failed', at: 2 }])).toBe(0);
    // A refund that failed before the last amount_refunded is already out of it.
    expect(refundedOnCharge({ amount: 300, at: 5 }, [{ amount: 200, status: 'failed', at: 2 }])).toBe(300);
    expect(refundedOnCharge({ amount: 900, at: 5 }, [{ amount: 200, status: 'failed', at: 6 }])).toBe(700);
  });

  it('records charges made without a PaymentIntent, and their refunds', async () => {
    const v = await visit('charges-api');
    const ch = id('ch');
    const charge = { id: ch, object: 'charge', amount: 2500, amount_captured: 2500, currency: 'eur', paid: true, captured: true, status: 'succeeded', payment_intent: null, customer: id('cus'), billing_details: { email: 'Old@Example.com' }, metadata: { rt_visitor_id: v.vid } };
    expect((await deliver('charge.succeeded', charge)).body.result).toBe('recorded');
    expect((await deliver('charge.succeeded', charge)).body.result).toBe('already recorded');
    expect(await payment(ch)).toMatchObject({ provider: 'stripe', amount: 2500, visitor_id: v.vid, email: 'old@example.com' });
    await deliver('charge.refunded', { ...charge, amount_refunded: 1000 });
    expect(await payment(`stripe_refund_${ch}`)).toMatchObject({ amount: -1000, visitor_id: v.vid });
    // A charge with a PaymentIntent is recorded through the PaymentIntent, not twice.
    expect((await deliver('charge.succeeded', { ...charge, id: id('ch'), payment_intent: id('pi') })).body.result).toBe('payment intent');
    expect((await deliver('charge.succeeded', { ...charge, id: id('ch'), captured: false })).body.result).toBe('not captured');
  }, 60_000);

  it('API 2025-03-31: an invoice and its PaymentIntent are one payment in any order, and refunds find it', async () => {
    const cus = id('cus'), sub = id('sub');
    const invoice = (inv: string) => ({ id: inv, amount_paid: 1900, currency: 'eur', customer: cus, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: sub, metadata: {} } } });
    // Invoice first, then a PaymentIntent whose description Stripe did not set, then the link.
    const in1 = id('in'), pi1 = id('pi');
    await deliver('invoice.paid', invoice(in1));
    expect((await deliver('payment_intent.succeeded', { id: pi1, amount_received: 1900, currency: 'eur', customer: cus, description: 'Pro plan' })).body.result).toBe('recorded');
    expect((await deliver('invoice_payment.paid', { id: id('inpay'), object: 'invoice_payment', invoice: in1, payment: { type: 'payment_intent', payment_intent: pi1 } })).body.result).toBe('linked');
    const one = await w.db.prepare('SELECT * FROM payments WHERE id IN (?, ?)').bind(in1, pi1).all<any>();
    expect(one.results).toHaveLength(1);
    expect(one.results[0]).toMatchObject({ amount: 1900, subscription_id: sub });
    // A refund names the PaymentIntent and the charge only.
    const ch = id('ch');
    expect((await deliver('charge.refunded', { id: ch, payment_intent: pi1, amount_refunded: 1900, currency: 'eur' })).body.result).toBe('refund recorded');

    // Link first, then the PaymentIntent, then the invoice: one row, keyed by the PaymentIntent.
    const in2 = id('in'), pi2 = id('pi');
    expect((await deliver('invoice_payment.paid', { id: id('inpay'), invoice: in2, payment: { type: 'payment_intent', payment_intent: pi2 } })).body.result).toBe('linked ahead');
    await deliver('payment_intent.succeeded', { id: pi2, amount_received: 1900, currency: 'eur', customer: cus, description: 'Pro plan' });
    expect((await deliver('invoice.paid', invoice(in2))).body.result).toBe('already recorded');
    expect(await payment(in2)).toBeNull();
    expect(await payment(pi2)).toMatchObject({ amount: 1900, subscription_id: sub, renewal: 1 });

    // Invoice, then the link, then a retried PaymentIntent: still one row.
    const in3 = id('in'), pi3 = id('pi');
    await deliver('invoice.paid', invoice(in3));
    await deliver('invoice_payment.paid', { id: id('inpay'), invoice: in3, payment: { type: 'payment_intent', payment_intent: pi3 } });
    expect((await deliver('payment_intent.succeeded', { id: pi3, amount_received: 1900, currency: 'eur', description: 'Pro plan' })).body.result).toBe('already recorded');
    expect(await payment(pi3)).toBeNull();
    expect(await payment(in3)).toMatchObject({ amount: 1900 });
  }, 60_000);

  it('one Stripe account, two sites: the payment goes to one site, decided the same way at every endpoint', async () => {
    const other = await w.createSite({ domain: 'second-shop.com', stripe_webhook_secret: SECRET });
    const toOther = { siteId: other.id };
    // The visitor belongs to the other site.
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129 Safari/537.36' },
      body: JSON.stringify({ w: other.id, t: 'pageview', u: 'https://second-shop.com/', r: '', vid, sid }),
    });
    const pi = id('pi'), cus = id('cus');
    const pay = { id: pi, amount_received: 700, currency: 'eur', customer: cus, metadata: { rt_visitor_id: vid } };
    expect((await deliver('payment_intent.succeeded', pay)).body.result).toBe('other site');
    expect((await deliver('payment_intent.succeeded', pay, toOther)).body.result).toBe('recorded');
    expect(await payment(pi)).toMatchObject({ site_id: other.id, visitor_id: vid });
    // Its refund and the next payment of the same customer follow it.
    expect((await deliver('charge.refunded', { id: id('ch'), payment_intent: pi, amount_refunded: 700, currency: 'eur' })).body.result).toBe('other site');
    const next = { id: id('pi'), amount_received: 700, currency: 'eur', customer: cus };
    expect((await deliver('payment_intent.succeeded', next)).body.result).toBe('other site');
    expect((await deliver('payment_intent.succeeded', next, toOther)).body.result).toBe('recorded');
    // A Checkout on the other site's domain goes there.
    const cs = { id: id('cs'), mode: 'payment', payment_status: 'paid', amount_total: 900, currency: 'eur', payment_intent: id('pi'), success_url: 'https://www.second-shop.com/thanks' };
    expect((await deliver('checkout.session.completed', cs)).body.result).toBe('other site');
    // Nothing ties it to a site: only sites with stripe_unpinned on record it.
    await w.admin(`/api/sites/${other.id}`, { method: 'PATCH', json: { stripe_unpinned: 0 } });
    const loose = { id: id('pi'), amount_received: 300, currency: 'eur' };
    expect((await deliver('payment_intent.succeeded', loose, toOther)).body.result).toBe('not pinned');
    expect((await deliver('payment_intent.succeeded', loose)).body.result).toBe('recorded');
    expect((await deliver('payment_intent.succeeded', loose, toOther)).body.result).toBe('other site');
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE id = ?').bind(loose.id).first<any>()).n).toBe(1);
  }, 60_000);

  it('donations through the Support link (rt_site_id=donation) count for no site, also with stripe_unpinned on', async () => {
    const meta = { rt_site_id: 'donation' };
    const pi = id('pi');
    expect((await deliver('payment_intent.succeeded', { id: pi, amount_received: 500, currency: 'eur', metadata: meta })).body.result).toBe('other site');
    const cs = { id: id('cs'), mode: 'payment', payment_status: 'paid', amount_total: 500, currency: 'eur', payment_intent: pi, metadata: meta };
    expect((await deliver('checkout.session.completed', cs)).body.result).toBe('other site');
    expect(await payment(pi)).toBeNull();
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM stripe_objects WHERE id IN (?, ?)').bind(pi, cs.id).first<any>()).n).toBe(0);
  }, 60_000);
});
