// Revenue reporting, round 3 (Maya, Lena): MRR in the weekly report, on the share page and the badge; the weekly
// report keeps web visitors and app launches apart; discount-aware Stripe MRR; "payment failed" and "subscription
// canceled" alerts; the subscriptions CSV; correcting and deleting other revenue through the API and the dashboard.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAlerts, subscriptionMessage } from '../src/worker/alerts';
import { buildDigest, changeText, digestMessage, moneyChange } from '../src/worker/digest';
import { resetShareCachesForTests } from '../src/worker/share';
import { stripeInvoiceEvent, stripeSubscriptionEvent } from '../src/worker/subscriptions';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const DAY = 86_400_000;
const SECRET = 'whsec_test_r3_0123456789abcdefABCDEF';
const HOOK = 'https://hooks.example.com/founderdata-r3';
const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

let w: TestWorker;
let sent: { type: string; body: any }[] = [];
const prevFetch = globalThis.fetch;

beforeAll(async () => {
  w = await startWorker();
  // The alert channel answers here; nothing leaves the machine.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://hooks.example.com/')) return prevFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ type: body.type, body });
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = prevFetch;
  await w.dispose();
});
beforeEach(() => {
  sent = [];
});

/** A subscription row as subscriptions.ts stores it. */
const subRow = (siteId: string, id: string, f: Record<string, unknown>) => {
  const row: Record<string, unknown> = { site_id: siteId, id, provider: 'stripe', status: 'active', started_at: Date.now(), updated_at: Date.now(), sandbox: 0, ...f };
  const cols = Object.keys(row);
  return w.db
    .prepare(`INSERT INTO subscriptions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run();
};

// ---------- the weekly report

describe('weekly report', () => {
  const MONDAY = Date.parse('2026-10-19T07:00:00Z');
  const lastWeek = Date.parse('2026-10-12T10:00:00Z');
  let web: any;
  let app: any;
  let n = 0;
  const session = (site: any, vid: string, at: number, ios = false) => {
    const id = `r3s${++n}`;
    return w.db
      .prepare('INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(site.id, id, vid, at, at, 'Direct', 'Direct', ios ? 'ios:com.example.habits' : site.domain)
      .run()
      .then(() => id);
  };
  const view = (site: any, sid: string, vid: string, path: string, at: number) =>
    w.db.prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES (?, ?, ?, ?, 'pageview', ?)").bind(site.id, sid, vid, at, path).run();

  beforeAll(async () => {
    web = await w.createSite({ domain: 'r3-tools.example', name: 'Tools', currency: 'USD' });
    app = await w.createSite({ domain: 'r3-habits.example', name: 'Habits', currency: 'USD', app_bundle_id: 'com.example.habits' });
    // Tools: 40 web visitors last week, 25 the week before.
    for (let i = 0; i < 40; i++) {
      const sid = await session(web, `tw${i}`, lastWeek + i * 1000);
      await view(web, sid, `tw${i}`, i < 30 ? '/' : '/pricing', lastWeek + i * 1000);
    }
    for (let i = 0; i < 25; i++) await session(web, `tp${i}`, lastWeek - 7 * DAY + i * 1000);
    // Habits: 30 app launches and 22 web visitors last week; 20 launches the week before.
    for (let i = 0; i < 30; i++) {
      const sid = await session(app, `ha${i}`, lastWeek + i * 1000, true);
      await view(app, sid, `ha${i}`, i < 20 ? '/Home' : '/Paywall', lastWeek + i * 1000);
    }
    for (let i = 0; i < 22; i++) {
      const sid = await session(app, `hw${i}`, lastWeek + i * 1000);
      await view(app, sid, `hw${i}`, '/landing', lastWeek + i * 1000);
    }
    for (let i = 0; i < 20; i++) await session(app, `hp${i}`, lastWeek - 7 * DAY + i * 1000, true);
    // Revenue: $50 last week, $40 the week before.
    const pay = (id: string, amount: number, at: number) =>
      w.db.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency) VALUES (?, ?, 'stripe', ?, ?, 'payment', 'USD')").bind(id, app.id, at, amount).run();
    await pay('r3_pay_1', 5000, lastWeek);
    await pay('r3_pay_0', 4000, lastWeek - 7 * DAY);
    // MRR: $49 paying since before the week, $19 new in it.
    await subRow(app.id, 'r3_sub_old', { paid_at: lastWeek - 30 * DAY, started_at: lastWeek - 30 * DAY, mrr: 4900, first_mrr: 4900 });
    await subRow(app.id, 'r3_sub_new', { paid_at: lastWeek, started_at: lastWeek, mrr: 1900, first_mrr: 1900 });
  });

  itPro('keeps web visitors and app launches apart, with MRR and top screens', async () => {
    const d = await buildDigest(w.db, MONDAY);
    const h = d.sites.find((s) => s.id === app.id)!;
    expect(h).toMatchObject({ webVisitors: 22, prevWebVisitors: 0, appVisitors: 30, prevAppVisitors: 20, visitors: 52 });
    expect(h.mrr).toEqual({ mrr: 6800, mrrStart: 4900, active: 2 });
    expect(h.topScreens.map((s) => s.path)).toEqual(['/Home', '/Paywall']);
    expect(h.topPages.map((s) => s.path)).toEqual(['/landing']);

    const m = digestMessage(d, [web.id, app.id]);
    expect(m.lines).toEqual([
      'Oct 12 to Oct 18 (UTC), compared with the week before.',
      'Revenue is payments net of refunds.',
      '',
      'All sites',
      'Revenue: $50.00, +25% (+$10.00), 1 new customer',
      'Web visitors: 62, +148% (+37)',
      'App visitors: 30, +50% (+10)',
      'MRR: $68.00, +39% (+$19.00), 2 paying subscriptions',
      '',
      'Habits',
      'Revenue: $50.00, +25% (+$10.00), 1 new customer',
      'Web visitors: 22, +22',
      'App visitors: 30, +50% (+10)',
      'MRR: $68.00, +39% (+$19.00), 2 paying subscriptions',
      'Top pages: /landing',
      'Top screens: Home, Paywall',
      // The week's MRR movement (round 6): a subscription that started paying last week.
      'New MRR $19.00.',
      '',
      'Tools',
      'Revenue: none',
      'Web visitors: 40, +60% (+15)',
      'Top pages: /, /pricing',
    ]);
    // No line adds launches to visitors.
    expect(m.lines.join('\n')).not.toMatch(/\b52\b|\b92\b/);
    expect(m.html).toContain('App visitors');
    expect(m.html).toContain('MRR');
    expect(m.data).toMatchObject({ totals: { webVisitors: 62, appVisitors: 30, mrr: { USD: 6800 }, mrrStart: { USD: 4900 } } });
  });

  it('shows changes as percent with the amount in brackets', () => {
    expect(changeText(120, 100)).toBe('+20% (+20)');
    expect(changeText(5, 1)).toBe('+4');
    expect(changeText(7, 7)).toBe('no change');
    expect(moneyChange({ USD: 8481 }, { USD: 10000 }, 'USD')).toBe('-15% (-$15.19)');
    expect(moneyChange({ USD: 500 }, {}, 'USD')).toBe('+$5.00');
    expect(moneyChange({ EUR: 500 }, { USD: 100 }, 'USD')).toBeNull();
  });
});

// ---------- share page and badge

describe('MRR on the share page and the badge', () => {
  let site: any;
  let bare: any;
  beforeAll(async () => {
    site = await w.createSite({ domain: 'r3-share.example', name: 'Share', currency: 'USD' });
    bare = await w.createSite({ domain: 'r3-bare.example', name: 'Bare', currency: 'USD' });
    await subRow(site.id, 'r3_share_a', { paid_at: Date.now() - 60 * DAY, started_at: Date.now() - 60 * DAY, mrr: 900000, first_mrr: 900000 });
    await subRow(site.id, 'r3_share_b', { paid_at: Date.now() - 2 * DAY, started_at: Date.now() - 2 * DAY, mrr: 80000, first_mrr: 80000 });
  });
  beforeEach(() => resetShareCachesForTests());
  const link = async (s: any, show_revenue: boolean) => (await w.admin(`/api/sites/${s.id}/share`, { method: 'POST', json: { kind: 'link', show_revenue } })).body.token as string;
  const get = (path: string) => w.fetch(path, { headers: { cookie: '' } });

  itPro('adds MRR to the overview of a link that shows revenue, cached like the rest', async () => {
    const token = await link(site, true);
    const first = await get(`/api/share/${token}/overview?period=30d`);
    expect(first.headers.get('x-cache')).toBe('miss');
    expect(((await first.json()) as any).mrr).toEqual({ mrr: 980000, mrrStart: 900000, active: 2 });
    expect((await get(`/api/share/${token}/overview?period=30d`)).headers.get('x-cache')).toBe('hit');
    // A filter: MRR does not follow visit filters, so it is left out.
    const filtered: any = await (await get(`/api/share/${token}/overview?period=30d&filters=${encodeURIComponent('{"channel":"Direct"}')}`)).json();
    expect(filtered.mrr).toBeNull();
  });

  it('leaves MRR out of a link without revenue, and null for a site without subscriptions', async () => {
    const hidden: any = await (await get(`/api/share/${await link(site, false)}/overview?period=30d`)).json();
    expect('mrr' in hidden).toBe(false);
    const none: any = await (await get(`/api/share/${await link(bare, true)}/overview?period=30d`)).json();
    expect(none.mrr).toBeNull();
  });

  itPro('draws an MRR badge, and visitors when the link or the site has no MRR', async () => {
    const svg = await (await get(`/api/share/${await link(site, true)}/badge.svg?metric=mrr`)).text();
    expect(svg).toContain('$9.8K MRR');
    expect(await (await get(`/api/share/${await link(site, false)}/badge.svg?metric=mrr`)).text()).toContain('visitors in 30 days');
    expect(await (await get(`/api/share/${await link(bare, true)}/badge.svg?metric=mrr`)).text()).toContain('visitors in 30 days');
  });
});

// ---------- Stripe discounts

describe('discount-aware Stripe MRR', () => {
  const now = Date.now();
  const sec = (ms: number) => Math.floor(ms / 1000);
  const sub = (f: Record<string, unknown>) => ({
    id: 'sub_d',
    status: 'active',
    customer: 'cus_d',
    start_date: sec(now - DAY),
    items: { data: [{ price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, nickname: 'Pro' }, quantity: 1 }] },
    ...f,
  });

  it('takes coupons off the subscription price', () => {
    // The older single `discount`, next to its id in `discounts`.
    const pct = stripeSubscriptionEvent(sub({ discount: { id: 'di_1', coupon: { percent_off: 20, duration: 'forever' } }, discounts: ['di_1'] }), now)!;
    expect(pct.price).toMatchObject({ amount: 3920, monthly: 3920 });
    expect(pct.listPrice).toBeUndefined();
    // API 2025-03-31: an expanded discount with its coupon under `source`.
    const off = stripeSubscriptionEvent(sub({ discounts: [{ id: 'di_2', source: { coupon: { amount_off: 1000, currency: 'usd', duration: 'repeating' } }, end: sec(now + 30 * DAY) }] }), now)!;
    expect(off.price).toMatchObject({ amount: 3900, monthly: 3900 });
    // A coupon for the first invoice only, or one that ended, takes nothing off.
    expect(stripeSubscriptionEvent(sub({ discounts: [{ id: 'di_3', coupon: { percent_off: 50, duration: 'once' } }] }), now)!.price?.amount).toBe(4900);
    expect(stripeSubscriptionEvent(sub({ discounts: [{ id: 'di_4', coupon: { percent_off: 50, duration: 'repeating' }, end: sec(now - DAY) }] }), now)!.price?.amount).toBe(4900);
    // A yearly plan: the amount off counts per year, a twelfth a month.
    const year = stripeSubscriptionEvent(
      sub({
        items: { data: [{ price: { unit_amount: 49000, currency: 'usd', recurring: { interval: 'year' } }, quantity: 1 }] },
        discount: { id: 'di_5', coupon: { amount_off: 10000, currency: 'usd', duration: 'forever' } },
      }),
      now,
    )!;
    expect(year.price).toMatchObject({ amount: 39000, monthly: 3250 });
  });

  it('keeps the list price, marked, when a discount is known only by its id', () => {
    const ev = stripeSubscriptionEvent(sub({ discounts: ['di_unknown'] }), now)!;
    expect(ev.price?.amount).toBe(4900);
    expect(ev.listPrice).toBe(true);
  });

  it("reads the discounted amount from the invoice's lines", () => {
    const inv = {
      currency: 'usd',
      customer: 'cus_d',
      customer_email: 'Jane@Example.com',
      customer_name: 'Jane',
      status_transitions: { paid_at: sec(now) },
      lines: { data: [{ type: 'subscription', amount: 4900, discount_amounts: [{ amount: 980, discount: 'di_unknown' }], period: { start: sec(now), end: sec(now + 30 * DAY) }, price: { recurring: { interval: 'month' } } }] },
    };
    const ev = stripeInvoiceEvent(inv, 'sub_d', now, true);
    expect(ev.price).toMatchObject({ amount: 3920, monthly: 3920 });
    expect(ev).toMatchObject({ paidPrice: true, customerEmail: 'jane@example.com', customerName: 'Jane' });
    // Without discounts the invoice only fills a gap, as before.
    const plain = stripeInvoiceEvent({ ...inv, lines: { data: [{ ...inv.lines.data[0], discount_amounts: [] }] } }, 'sub_d', now, true);
    expect(plain.paidPrice).toBeUndefined();
    // An invoice-level total, when the lines carry none, is spread over the lines.
    const total = stripeInvoiceEvent({ ...inv, total_discount_amounts: [{ amount: 490 }], lines: { data: [{ ...inv.lines.data[0], discount_amounts: [] }] } }, 'sub_d', now, true);
    expect(total.price?.amount).toBe(4410);
  });
});

// ---------- payment failed and canceled alerts, through the Stripe webhook

describe('payment failed and subscription canceled alerts', () => {
  let site: any;
  const sec = (ms: number) => Math.floor(ms / 1000);
  const deliver = async (type: string, object: Record<string, unknown>, created = Date.now()) => {
    const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, created: sec(created), data: { object } });
    const res = await w.fetch(`/api/webhooks/stripe/${site.id}`, { method: 'POST', headers: { 'stripe-signature': sign(body), 'content-type': 'application/json' }, body });
    await w.flush();
    return res.status;
  };
  const subscription = (id: string, f: Record<string, unknown> = {}) => ({
    id,
    object: 'subscription',
    status: 'active',
    customer: 'cus_r3',
    start_date: sec(Date.now() - 60_000),
    current_period_end: sec(Date.now() + 30 * DAY),
    discounts: ['di_launch'],
    items: { data: [{ price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month' }, nickname: 'Pro monthly' }, quantity: 1 }] },
    ...f,
  });
  const invoice = (id: string, sub: string, f: Record<string, unknown> = {}) => ({
    id,
    object: 'invoice',
    subscription: sub,
    customer: 'cus_r3',
    customer_email: 'jane@example.com',
    customer_name: 'Jane Doe',
    currency: 'usd',
    amount_paid: 3920,
    billing_reason: 'subscription_create',
    payment_intent: `pi_${id}`,
    status_transitions: { paid_at: sec(Date.now()) },
    lines: {
      data: [
        { type: 'subscription', amount: 4900, discount_amounts: [{ amount: 980, discount: 'di_launch' }], period: { start: sec(Date.now()), end: sec(Date.now() + 30 * DAY) }, price: { recurring: { interval: 'month' }, nickname: 'Pro monthly' } },
      ],
    },
    ...f,
  });
  const row = (id: string) => w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, id).first<any>();
  const ofType = (t: string) => sent.filter((s) => s.type === t);

  beforeAll(async () => {
    site = await w.createSite({ domain: 'r3-saas.example', name: 'ShipKit', currency: 'USD', stripe_webhook_secret: SECRET });
    // A channel stored before these alerts existed: its JSON has none of the new keys.
    await w.db
      .prepare("INSERT INTO alert_channels (id, kind, name, target, secret, alerts, sites, created_at) VALUES ('old1', 'webhook', 'Old', ?, NULL, ?, NULL, 0)")
      .bind(`${HOOK}/old`, JSON.stringify({ purchase: true, refund: true, daily: true, payments_stopped: true, cap: true, weekly: true }))
      .run();
    const created = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', target: `${HOOK}/new`, name: 'New' } });
    expect(created.body.alerts).toMatchObject({ payment_failed: true, canceled: true });
  });

  it('is on for new channels and off for channels stored before it', () => {
    expect(parseAlerts(JSON.stringify({ purchase: true }))).toMatchObject({ payment_failed: false, canceled: false });
    expect(parseAlerts(JSON.stringify({ payment_failed: true, canceled: true }))).toMatchObject({ payment_failed: true, canceled: true });
  });

  it('records the discounted price, from the first invoice, as new MRR', async () => {
    expect(await deliver('customer.subscription.created', subscription('sub_r3a'))).toBe(200);
    expect((await row('sub_r3a')).mrr).toBe(4900);
    expect(await deliver('invoice.paid', invoice('in_r3a1', 'sub_r3a'))).toBe(200);
    // The coupon's price replaces the list price as the first price: no contraction.
    expect(await row('sub_r3a')).toMatchObject({ mrr: 3920, first_mrr: 3920, mrr_changed_at: null, amount: 3920 });
    // An update that names the coupon by id only keeps the discounted price.
    await deliver('customer.subscription.updated', subscription('sub_r3a', { metadata: { note: 'x' } }));
    expect((await row('sub_r3a')).mrr).toBe(3920);
    expect(ofType('payment_failed')).toHaveLength(0);
    expect(ofType('canceled')).toHaveLength(0);
  });

  it('alerts once when a renewal fails, naming the customer', async () => {
    const failed = invoice('in_r3a2', 'sub_r3a', { billing_reason: 'subscription_cycle', amount_paid: 0, status_transitions: {} });
    // A minute after the first payment: the renewal's failure.
    await deliver('invoice.payment_failed', failed, Date.now() + 60_000);
    const alerts = ofType('payment_failed');
    expect(alerts.map((a) => a.body.title)).toEqual(['Payment failed on ShipKit: Jane Doe <jane@example.com>, Pro monthly']);
    // Only the new channel: the old one has the alert off.
    expect(sent.every((s) => !JSON.stringify(s).includes('"Old"'))).toBe(true);
    expect(alerts[0].body).toMatchObject({ event: 'payment_failed', subscription_id: 'sub_r3a', customer_email: 'jane@example.com', mrr: 3920, mrr_text: '$39.20', provider: 'stripe' });
    expect(alerts[0].body.lines).toContain('MRR at risk: $39.20 a month');
    // Stripe retries and sends the past due subscription: still past due, no second alert.
    sent = [];
    await deliver('invoice.payment_failed', failed, Date.now() + 120_000);
    await deliver('customer.subscription.updated', subscription('sub_r3a', { status: 'past_due' }), Date.now() + 180_000);
    expect(ofType('payment_failed')).toHaveLength(0);
  });

  it('alerts once when auto-renew is turned off, not again when it ends', async () => {
    await deliver('customer.subscription.created', subscription('sub_r3b', { discounts: [] }));
    await deliver('invoice.paid', invoice('in_r3b1', 'sub_r3b', { amount_paid: 4900, lines: { data: [] } }));
    sent = [];
    await deliver('customer.subscription.updated', subscription('sub_r3b', { discounts: [], cancel_at_period_end: true, canceled_at: sec(Date.now()) }), Date.now() + 1000);
    const alerts = ofType('canceled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body.title).toBe('Subscription canceled on ShipKit: Pro monthly, $49.00 MRR');
    // The customer comes from the payment the invoice recorded.
    expect(alerts[0].body.lines).toEqual(expect.arrayContaining(['Customer: Jane Doe <jane@example.com>', 'MRR lost: $49.00 a month', 'Provider: Stripe']));
    expect(alerts[0].body.lines.some((l: string) => l.startsWith('Paid until '))).toBe(true);
    sent = [];
    await deliver('customer.subscription.deleted', subscription('sub_r3b', { discounts: [], status: 'canceled', ended_at: sec(Date.now()) }), Date.now() + 2000);
    expect(ofType('canceled')).toHaveLength(0);
    expect((await row('sub_r3b')).ended_at).not.toBeNull();
  });

  it('stays quiet for old events, replays and trials', async () => {
    const old = Date.now() - 10 * DAY;
    await deliver('customer.subscription.created', subscription('sub_r3c', { discounts: [], start_date: sec(old) }), old);
    await deliver('customer.subscription.deleted', subscription('sub_r3c', { discounts: [], status: 'canceled', start_date: sec(old) }), old + 1000);
    await deliver('customer.subscription.created', subscription('sub_r3d', { discounts: [], status: 'trialing', trial_start: sec(Date.now()), trial_end: sec(Date.now() + 7 * DAY) }));
    await deliver('customer.subscription.updated', subscription('sub_r3d', { discounts: [], status: 'trialing', cancel_at_period_end: true }), Date.now() + 1000);
    expect(ofType('canceled')).toHaveLength(0);
  });

  it('says "ended" for a subscription that ends without a cancel first', () => {
    const m = subscriptionMessage(
      { id: 's', name: 'Habits', domain: 'h.example', currency: 'EUR' } as any,
      'canceled',
      { id: '2000001', provider: 'app_store', product: 'pro.yearly', customer_id: 'apple:2000001', mrr: 417, expires_at: Date.now() - DAY, ended_at: Date.now() - DAY, channel: 'Organic Search', source: 'Google', campaign: null },
      { email: null, name: null },
    );
    expect(m.title).toBe('Subscription ended on Habits: pro.yearly, €4.17 MRR');
    expect(m.lines).toEqual(['Customer: apple:2000001, no email known', 'Product: pro.yearly', 'MRR lost: €4.17 a month', 'Source: Google (Organic Search)', 'Provider: App Store']);
  });
});

// ---------- subscriptions CSV

describe('GET /api/sites/:id/export/subscriptions.csv', () => {
  let site: any;
  beforeAll(async () => {
    site = await w.createSite({ domain: 'r3-csv.example', name: 'CSV', currency: 'USD' });
    const t = Date.parse('2026-09-01T00:00:00Z');
    await subRow(site.id, 'sub_csv1', {
      product: '=HYPERLINK("x")', customer_id: 'cus_csv', paid_at: t, renewed_at: t, started_at: t, mrr: 3920, first_mrr: 3920, currency: 'USD', amount: 3920,
      interval: 'month', interval_count: 1, expires_at: Date.now() + 10 * DAY, channel: 'Organic Search', source: 'Google', source_domain: 'google.com', campaign: 'launch',
    });
    await subRow(site.id, 'sub_csv2', { product: 'Pro', paid_at: t - DAY, started_at: t - DAY, mrr: 1900, first_mrr: 1900, expires_at: Date.now() - 40 * DAY });
    await subRow(site.id, 'sub_csv_sandbox', { provider: 'app_store_sandbox', sandbox: 1, paid_at: t, started_at: t, mrr: 999 });
    await w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, customer_id, email) VALUES ('pi_csv', ?, 'stripe', ?, 3920, 'payment', 'USD', 'cus_csv', 'ann@example.com')")
      .bind(site.id, t)
      .run();
  });

  it('lists every subscription row with its MRR, dates, source and email', async () => {
    const res = await w.admin(`/api/sites/${site.id}/export/subscriptions.csv?period=7d`);
    expect(res.status).toBe(200);
    const lines = (res.body as string).trim().split('\r\n');
    expect(lines[0]).toBe(
      'subscription_id,provider,product,status,mrr,first_mrr,currency,price,price_currency,interval,interval_count,started_at,trial_start,trial_end,first_paid_at,last_paid_at,paid_until,canceled_at,ended_at,end_inferred,past_due_since,customer_id,email,visitor_id,source,channel,campaign,referrer_domain',
    );
    // Oldest first, whatever the period; sandbox rows stay out.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^sub_csv2,stripe,Pro,expired,19,19,USD,/);
    expect(lines[1]).toMatch(/,1,,,,,,,,$/);
    const first = lines[2].split(',');
    expect(first.slice(0, 7)).toEqual(['sub_csv1', 'stripe', `"'=HYPERLINK(""x"")"`, 'active', '39.2', '39.2', 'USD']);
    expect(lines[2]).toContain(',cus_csv,ann@example.com,,Google,Organic Search,launch,google.com');
  });

  it('names the file without dates and lists itself in the error text', async () => {
    const res = await w.fetch(`/api/sites/${site.id}/export/subscriptions.csv`);
    expect(res.headers.get('content-disposition')).toMatch(/r3-csv\.example-subscriptions-\d{4}-\d{2}-\d{2}\.csv/);
    const bad = await w.admin(`/api/sites/${site.id}/export/nothing.csv`);
    expect(bad.body.error).toContain('subscriptions');
  });

  it('applies the channel filter of the Subscriptions tab', async () => {
    const res = await w.admin(`/api/sites/${site.id}/export/subscriptions.csv?filters=${encodeURIComponent('{"channel":"Organic Search"}')}`);
    expect((res.body as string).trim().split('\r\n')).toHaveLength(2);
  });
});

// ---------- correcting and deleting other revenue

describe('correcting other revenue', () => {
  let site: any;
  const post = (json: unknown) => w.fetch('/api/v1/payments', { method: 'POST', json, headers: { authorization: `Bearer ${site.api_key}` } });
  const del = (tx: string, key = site.api_key, q = '') => w.fetch(`/api/v1/payments/${encodeURIComponent(tx)}${q}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
  const payment = (id: string) => w.db.prepare('SELECT * FROM payments WHERE site_id = ? AND id = ?').bind(site.id, `${site.id}:${id}`).first<any>();

  beforeAll(async () => {
    site = await w.createSite({ domain: 'r3-content.example', name: 'Content', currency: 'USD' });
  });

  it('corrects a refund sent again with another amount, and keeps it under other revenue', async () => {
    expect((await post({ transaction_id: 'adsense-10', amount: 412.5, kind: 'income', product: 'AdSense' })).status).toBe(200);
    // The mistake from the round 3 report: a refund of 0, then the right one.
    expect((await post({ transaction_id: 'adsense-10', amount: 0, refunded: true })).status).toBe(200);
    expect(await payment('adsense-10:refund')).toMatchObject({ provider: 'income', kind: 'refund', amount: 0 });
    const fixed = await post({ transaction_id: 'adsense-10', amount: 412.5, refunded: true });
    expect(await fixed.json()).toMatchObject({ ok: true, updated: true });
    expect((await payment('adsense-10:refund')).amount).toBe(-41250);
    const lines = (await w.admin(`/api/sites/${site.id}/revenue?period=7d`)).body;
    expect(lines.find((l: any) => l.provider === 'income')).toMatchObject({ net: 0 });
  });

  it('corrects other revenue sent again with another amount', async () => {
    await post({ transaction_id: 'amazon-10', amount: 187.2, kind: 'income' });
    w.takeRowsWritten();
    expect(await (await post({ transaction_id: 'amazon-10', amount: 178.2, kind: 'income' })).json()).toMatchObject({ updated: true });
    expect((await payment('amazon-10')).amount).toBe(17820);
    // The correction writes the one row (docs/GUIDE.md cost table).
    await w.flush();
    expect(w.takeRowsWritten()).toBe(1);
    // The same amount again is a harmless rerun.
    expect(await (await post({ transaction_id: 'amazon-10', amount: 178.2, kind: 'income' })).json()).toEqual({ ok: true, attributed: false, visitor_id: null });
  });

  it('answers 409 for a payment sent again with another amount or kind', async () => {
    await post({ transaction_id: 'txn-1', amount: 29.99 });
    expect((await post({ transaction_id: 'txn-1', amount: 29.99 })).status).toBe(200);
    const res = await post({ transaction_id: 'txn-1', amount: 19.99 });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('already stored with 29.99 USD');
    expect(error).toContain('DELETE /api/v1/payments/txn-1');
    expect((await post({ transaction_id: 'txn-1', amount: 29.99, kind: 'income' })).status).toBe(409);
    expect((await payment('txn-1')).amount).toBe(2999);
  });

  it('deletes a payment and its refund with the API key, and nothing a webhook recorded', async () => {
    await post({ transaction_id: 'txn-2', amount: 10 });
    await post({ transaction_id: 'txn-2', amount: 10, refunded: true });
    expect((await del('txn-2', 'rt_wrong')).status).toBe(401);
    expect((await del('txn-2', site.api_key, '?refunded=true')).status).toBe(200);
    expect(await payment('txn-2:refund')).toBeNull();
    expect(await payment('txn-2')).not.toBeNull();
    w.takeRowsWritten();
    expect(await (await del('txn-2')).json()).toEqual({ ok: true, deleted: 1 });
    await w.flush();
    expect(w.takeRowsWritten()).toBe(1);
    expect((await del('txn-2')).status).toBe(404);
    await w.db.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency) VALUES ('pi_r3_hook', ?, 'stripe', ?, 100, 'payment', 'USD')").bind(site.id, Date.now()).run();
    expect((await del('pi_r3_hook')).status).toBe(404);
  });

  it('lists other revenue in the dashboard and deletes a row', async () => {
    const list = (await w.admin(`/api/sites/${site.id}/income?period=7d`)).body as any[];
    expect(list.map((r) => [r.transactionId, r.kind, r.amount]).sort()).toEqual(
      [
        ['adsense-10', 'income', 41250],
        ['adsense-10', 'refund', -41250],
        ['amazon-10', 'income', 17820],
      ].sort(),
    );
    expect((await w.admin(`/api/sites/${site.id}/income/amazon-10`, { method: 'DELETE' })).body).toEqual({ ok: true, deleted: 1 });
    // Only other revenue: a payment is not deleted here.
    expect((await w.admin(`/api/sites/${site.id}/income/txn-1`, { method: 'DELETE' })).status).toBe(404);
    expect(((await w.admin(`/api/sites/${site.id}/income?period=7d`)).body as any[]).map((r) => r.transactionId)).toEqual(['adsense-10', 'adsense-10']);
  });
});
