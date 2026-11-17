// Round 6, build C: attribution that holds for identified people across days, renewals that stay with the visit
// that acquired the customer, and a source that outlives the visit (migration 0064).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDigest } from '../src/worker/digest';
import { pruneOldData } from '../src/worker/retention';
import { startWorker, type TestWorker } from './helpers/worker';

const DAY = 86_400_000;
const SECRET = 'whsec_attribution_r6_test';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const iso = (ms: number) => new Date(ms).toISOString();

describe('attribution and revenue correctness (round 6, build C)', () => {
  let w: TestWorker;
  let site: any;
  let key: string;
  const now = Date.now();

  const session = (id: string, vid: string, ts: number, source: string, channel: string, campaign: string | null = null) =>
    w.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, source, channel, utm_campaign)
         VALUES (?, ?, ?, ?, ?, 1, 'attr.example', ?, ?, ?)`,
      )
      .bind(site.id, id, vid, ts, ts + 60_000, source, channel, campaign)
      .run();
  const visitor = (id: string, ts: number, ident: { user_id?: string; email?: string } = {}) =>
    w.db
      .prepare('INSERT INTO visitors (site_id, id, first_seen, user_id, email) VALUES (?, ?, ?, ?, ?)')
      .bind(site.id, id, ts, ident.user_id ?? null, ident.email ?? null)
      .run();
  const api = (path: string, body: Record<string, unknown>) =>
    w.fetch(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pay = async (body: Record<string, unknown>) => {
    const res = await api('/api/v1/payments', { currency: 'USD', ...body });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return res.json() as Promise<any>;
  };
  const payment = (tx: string) =>
    w.db.prepare('SELECT * FROM payments WHERE site_id = ? AND id = ?').bind(site.id, `${site.id}:${tx}`).first<any>();
  const stripe = async (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({ id: `evt_${Math.random()}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const res = await w.fetch(`/api/webhooks/stripe/${site.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}` },
      body,
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'attr.example', currency: 'USD', stripe_webhook_secret: SECRET });
    key = (await w.db.prepare('SELECT api_key FROM sites WHERE id = ?').bind(site.id).first<{ api_key: string }>())!.api_key;
  });
  afterAll(() => w.dispose());

  it('an identified visitor is credited across days, and the renewal three weeks later keeps the acquisition source', async () => {
    // Day 0: found the site on Product Hunt and signed up (identify). Cookieless ids change daily.
    await visitor('v-ph', now - 40 * DAY, { user_id: 'user-r6' });
    await session('s-ph', 'v-ph', now - 40 * DAY, 'Product Hunt', 'Referral', 'launch');
    // Day 5: came back directly under a new id, signed in and paid.
    await visitor('v-direct', now - 35 * DAY, { user_id: 'user-r6' });
    await session('s-direct', 'v-direct', now - 35 * DAY, 'Direct', 'Direct');
    const first = await pay({ transaction_id: 'r6-first', amount: 19, visitor_id: 'v-direct', customer_id: 'cus_r6', timestamp: iso(now - 35 * DAY + 600_000) });
    expect(first).toMatchObject({ attributed: true, visitor_id: 'v-direct' });
    expect(await payment('r6-first')).toMatchObject({ session_id: 's-ph', channel: 'Referral', source: 'Product Hunt', campaign: 'launch', renewal: 0 });

    // Three weeks later: back from a Google search under yet another id, signed in; the renewal arrives.
    await visitor('v-google', now - 14 * DAY, { user_id: 'user-r6' });
    await session('s-google', 'v-google', now - 14 * DAY, 'Google', 'Organic Search');
    await pay({ transaction_id: 'r6-renewal', amount: 19, visitor_id: 'v-google', customer_id: 'cus_r6', timestamp: iso(now - 14 * DAY + 600_000) });
    expect(await payment('r6-renewal')).toMatchObject({ session_id: 's-ph', source: 'Product Hunt', channel: 'Referral', renewal: 1 });

    // The breakdown credits both payments to Product Hunt, none to Google.
    const rows = (await w.admin(`/api/sites/${site.id}/breakdown?period=custom&from=${iso(now - 60 * DAY).slice(0, 10)}&to=${iso(now).slice(0, 10)}&dim=source`)).body;
    expect(rows.find((r: any) => r.label === 'Product Hunt')).toMatchObject({ revenue: 3800, customers: 1 });
    expect(rows.find((r: any) => r.label === 'Google')?.revenue ?? 0).toBe(0);
  });

  it("erasing a visit clears it from another visitor id's payment and subscription credited to it", async () => {
    await visitor('v-er-hn', now - 20 * DAY, { user_id: 'user-erase' });
    await session('s-er-hn', 'v-er-hn', now - 20 * DAY, 'Hacker News', 'Referral', 'show-hn');
    await visitor('v-er-buy', now - 18 * DAY, { user_id: 'user-erase' });
    await session('s-er-buy', 'v-er-buy', now - 18 * DAY, 'Direct', 'Direct');
    await pay({ transaction_id: 'r6-erase', amount: 9, visitor_id: 'v-er-buy', timestamp: iso(now - 18 * DAY + 60_000) });
    expect(await payment('r6-erase')).toMatchObject({ session_id: 's-er-hn', source: 'Hacker News' });
    await w.db
      .prepare(
        `INSERT INTO subscriptions (site_id, id, provider, status, started_at, updated_at, visitor_id, session_id, channel, source, campaign)
         VALUES (?, 'sub-r6-erase', 'stripe', 'active', ?, 1, 'v-er-buy', 's-er-hn', 'Referral', 'Hacker News', 'show-hn')`,
      )
      .bind(site.id, now - 18 * DAY)
      .run();

    const res = await w.admin(`/api/sites/${site.id}/visitors/v-er-hn`, { method: 'DELETE' });
    expect(res.body).toMatchObject({ ok: true, visitors: 1, sessions: 1, payments: 1, subscriptions: 1 });
    // The buyer's id was not erased: the payment stays theirs, without the erased visit and the source it copied.
    expect(await payment('r6-erase')).toMatchObject({ visitor_id: 'v-er-buy', session_id: null, channel: null, source: null, campaign: null });
    expect(await w.db.prepare("SELECT visitor_id, session_id, channel, source, campaign FROM subscriptions WHERE id = 'sub-r6-erase'").first()).toEqual({
      visitor_id: 'v-er-buy', session_id: null, channel: null, source: null, campaign: null,
    });
  });

  it('visitors the site never identified stay apart', async () => {
    await visitor('v-anon-1', now - 30 * DAY);
    await session('s-anon-x', 'v-anon-1', now - 30 * DAY, 'X', 'Social');
    await visitor('v-anon-2', now - 20 * DAY);
    await session('s-anon-direct', 'v-anon-2', now - 20 * DAY, 'Direct', 'Direct');
    await pay({ transaction_id: 'r6-anon', amount: 5, visitor_id: 'v-anon-2', timestamp: iso(now - 20 * DAY + 60_000) });
    expect(await payment('r6-anon')).toMatchObject({ session_id: 's-anon-direct', channel: 'Direct' });
  });

  it("a buyer's email joins the visits identified with it", async () => {
    await visitor('v-mail-1', now - 25 * DAY, { email: 'pat@example.com' });
    await session('s-mail-news', 'v-mail-1', now - 25 * DAY, 'Newsletter', 'Email');
    await visitor('v-mail-2', now - 10 * DAY);
    await session('s-mail-direct', 'v-mail-2', now - 10 * DAY, 'Direct', 'Direct');
    await pay({ transaction_id: 'r6-mail', amount: 7, visitor_id: 'v-mail-2', email: 'Pat@Example.com', timestamp: iso(now - 10 * DAY + 60_000) });
    expect(await payment('r6-mail')).toMatchObject({ session_id: 's-mail-news', source: 'Newsletter' });
  });

  it('a payment keeps its source after its visit is deleted', async () => {
    const old = now - 800 * DAY; // past RETENTION_MONTHS (24)
    await visitor('v-old', old);
    await session('s-old', 'v-old', old, 'Reddit', 'Social', 'spring');
    await pay({ transaction_id: 'r6-old-first', amount: 50, visitor_id: 'v-old', customer_id: 'cus_old', timestamp: iso(old + 60_000) });
    await pay({ transaction_id: 'r6-old-renewal', amount: 50, customer_id: 'cus_old', timestamp: iso(now - 3 * DAY) });
    // A payment stored before migration 0064 has no copy yet: the cleanup copies it before it deletes the visit.
    await w.db
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES ('legacy-r6', ?, 'stripe', ?, 30, 'payment', 'USD', 'v-old', 's-old')`)
      .bind(site.id, now - 2 * DAY)
      .run();
    await pruneOldData(w.db, now);
    expect(await w.db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, 's-old').first()).toBeNull();
    expect(await payment('r6-old-renewal')).toMatchObject({ session_id: 's-old', source: 'Reddit', channel: 'Social', campaign: 'spring' });
    expect(await w.db.prepare("SELECT source FROM payments WHERE id = 'legacy-r6'").first()).toEqual({ source: 'Reddit' });

    const q = `period=custom&from=${iso(now - 7 * DAY).slice(0, 10)}&to=${iso(now).slice(0, 10)}`;
    for (const [dim, label] of [['source', 'Reddit'], ['channel', 'Social'], ['campaign', 'spring']]) {
      const rows = (await w.admin(`/api/sites/${site.id}/breakdown?${q}&dim=${dim}`)).body;
      expect(rows.find((r: any) => r.label === label), dim).toMatchObject({ revenue: 5000 + 30, visitors: 0 });
      expect(rows.find((r: any) => r.noVisit), dim).toBeUndefined();
    }
    // A filter on the kept source keeps the payments; a filter on anything else about the deleted visit drops them.
    const filtered = (filters: Record<string, string>, dim: string) =>
      w.admin(`/api/sites/${site.id}/breakdown?${q}&dim=${dim}&filters=${encodeURIComponent(JSON.stringify(filters))}`).then((r) => r.body as any[]);
    expect((await filtered({ source: 'Reddit' }, 'campaign')).find((r) => r.label === 'spring')).toMatchObject({ revenue: 5030 });
    expect((await filtered({ channel: 'Social', utm_campaign: 'spring' }, 'source')).find((r) => r.label === 'Reddit')).toMatchObject({ revenue: 5030 });
    expect((await filtered({ country: 'US' }, 'source')).find((r) => r.label === 'Reddit')).toBeUndefined();
    expect((await filtered({ source: 'Reddit' }, 'country')).reduce((n, r) => n + (r.revenue ?? 0), 0)).toBe(0);

    const list = (await w.admin(`/api/sites/${site.id}/customers?${q}`)).body;
    const rows = list.rows ?? list;
    expect(rows.find((r: any) => r.id === `${site.id}:r6-old-renewal`)).toMatchObject({ source: 'Reddit', channel: 'Social', utm_campaign: 'spring' });

    // Home (and the portfolio built on it) and the Monday report read the kept source too.
    const home = (await w.admin('/api/home?period=7d')).body;
    expect(home.sources.find((r: any) => r.label === 'Reddit')).toMatchObject({ channel: 'Social', revenue: { USD: 5030 } });
    expect(home.sources.find((r: any) => r.noVisit)).toBeUndefined();
    expect(home.payments.find((r: any) => r.id === `${site.id}:r6-old-renewal`)).toMatchObject({ source: 'Reddit', channel: 'Social' });
    // The report covers the full week before weekOf's week: the week the legacy payment fell in.
    const digest = await buildDigest(w.db, now, 'UTC', now - 2 * DAY + 7 * DAY);
    const top = digest.sites.find((s) => s.id === site.id)!.topSources;
    expect(top.find((x) => x.label === 'Reddit')?.revenue).toBeGreaterThanOrEqual(30);
  });

  it('a webhook before the return page, and a Stripe Checkout after the invoice, credit the same visits', async () => {
    // Monday: came from a tweet and signed up. Friday: back under a new id, signed in, paid.
    await visitor('v-cl-mon', now - 5 * DAY, { user_id: 'user-claim' });
    await session('s-cl-tweet', 'v-cl-mon', now - 5 * DAY, 'X', 'Social', 'thread');
    await visitor('v-cl-fri', now - DAY, { user_id: 'user-claim' });
    // The Dodo webhook came first and found no visitor: the payment is stored unlinked.
    await w.db
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, email) VALUES ('pay_r6claim01', ?, 'dodo', ?, 2900, 'payment', 'USD', 'buyer@example.com')`)
      .bind(site.id, now - 60_000)
      .run();
    // Then the return page, a direct visit of Friday's id.
    const res = await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: JSON.stringify({ t: 'pageview', w: site.id, u: 'https://attr.example/thanks?payment_id=pay_r6claim01', r: '', vid: 'v-cl-fri', sid: crypto.randomUUID() }),
    });
    expect(res.status).toBeLessThan(300);
    expect(await w.db.prepare("SELECT visitor_id, matched_by, session_id, source, campaign FROM payments WHERE id = 'pay_r6claim01'").first()).toEqual({
      visitor_id: 'v-cl-fri', matched_by: 'return_page', session_id: 's-cl-tweet', source: 'X', campaign: 'thread',
    });

    // Stripe: invoice.paid stored the payment before checkout.session.completed named the visitor.
    await w.db
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, subscription_id) VALUES ('in_r6link', ?, 'stripe', ?, 4900, 'payment', 'USD', 'sub_r6link')`)
      .bind(site.id, now - 60_000)
      .run();
    await stripe('checkout.session.completed', { mode: 'subscription', subscription: 'sub_r6link', customer: 'cus_r6link', metadata: { rt_visitor_id: 'v-cl-fri' } });
    expect(await w.db.prepare("SELECT visitor_id, matched_by, session_id, source FROM payments WHERE id = 'in_r6link'").first()).toEqual({
      visitor_id: 'v-cl-fri', matched_by: 'metadata', session_id: 's-cl-tweet', source: 'X',
    });
  });

  it('POST /api/v1/goals finds the person by user_id or email', async () => {
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    const ev = (body: Record<string, unknown>) =>
      w.fetch('/api/event', { method: 'POST', headers: { 'user-agent': UA }, body: JSON.stringify({ w: site.id, u: 'https://attr.example/app', r: '', vid, sid, ...body }) });
    await ev({ t: 'pageview' });
    await ev({ t: 'identify', p: { user_id: 'user-goal', email: 'Goal@Example.com' } });
    for (const who of [{ user_id: 'user-goal' }, { email: 'goal@example.com' }]) {
      const res = await api('/api/v1/goals', { ...who, name: 'upgraded' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, visitor_id: vid });
    }
    const goals = await w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND session_id = ? AND type = 'goal' AND name = 'upgraded'").bind(site.id, sid).first<{ n: number }>();
    expect(goals!.n).toBe(2);
    const missing = await api('/api/v1/goals', { user_id: 'nobody', name: 'upgraded' });
    expect(missing.status).toBe(404);
    expect(((await api('/api/v1/goals', { name: 'upgraded' })).status)).toBe(400);
  });

  it('Stripe payments name their product: invoice lines and Checkout metadata', async () => {
    await stripe('invoice.paid', {
      id: 'in_r6_prod', customer: 'cus_r6_prod', amount_paid: 900, currency: 'usd', billing_reason: 'manual', payment_intent: 'pi_r6_prod',
      lines: { data: [{ type: 'invoiceitem', description: 'Setup fee' }, { type: 'subscription', proration: false, price: { nickname: 'Team monthly' } }] },
    });
    expect(await w.db.prepare("SELECT product FROM payments WHERE id = 'pi_r6_prod'").first()).toEqual({ product: 'Team monthly' });
    await stripe('checkout.session.completed', {
      mode: 'payment', payment_status: 'paid', amount_total: 4900, currency: 'usd', payment_intent: 'pi_r6_checkout', metadata: { product: 'Lifetime deal' },
    });
    expect(await w.db.prepare("SELECT product FROM payments WHERE id = 'pi_r6_checkout'").first()).toEqual({ product: 'Lifetime deal' });
  });
});
