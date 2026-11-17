// Privacy and ops, round 3 (docs/PRIVACY.md, docs/GUIDE.md): what a phone may read, the hashed and purged login
// failures, the Stripe import key timeout, who handled an erase and the log that outlives its site, noindex on share
// pages, the "no payments connected" mode, refused webhook deliveries, "payments stopped arriving" for small
// products, and alert previews.
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../src/worker/alerts';
import { refusedWebhooks, resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { home } from '../src/worker/home';
import { pruneOldData } from '../src/worker/retention';
import { gapDaysNeeded, stoppedProviders, stoppedText } from '../src/worker/silence';
import { KEY_IDLE_MS, STOPPED_MESSAGE, stopIdleImports } from '../src/worker/stripe-import';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const DAY = 86_400_000;
const HOOK = 'https://hooks.example.com/r3';

interface Sent {
  url: string;
  body: any;
}
let sent: Sent[] = [];
let stripeCalls: string[] = [];
const prevFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://hooks.example.com/')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ ok: true });
    }
    if (url.startsWith('https://api.stripe.com/')) {
      stripeCalls.push(url);
      return Response.json({ data: [], has_more: false });
    }
    return prevFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = prevFetch;
});
beforeEach(() => {
  sent = [];
  stripeCalls = [];
});

describe('privacy r3: what a phone reads, and the login lockout', () => {
  let w: TestWorker;
  let site: any;
  let token = '';
  beforeAll(async () => {
    w = await startWorker({ VIEWER_PASSWORD: 'viewer-password', VIEWER_PII: '1', PHONE_PII: '0' });
    site = await w.createSite();
    const login = await (await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Phone' }, headers: { cookie: '' } })).json<any>();
    token = login.token;
    const now = Date.now();
    await w.db.batch([
      w.db.prepare("INSERT INTO visitors (site_id, id, first_seen, user_id, name, email) VALUES (?, 'vid-1', ?, 'u-7', 'Grace Hopper', 'grace@example.org')").bind(site.id, now),
      w.db.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, 'sid-1', 'vid-1', ?, ?, 'Direct/None', 'Direct')").bind(site.id, now, now),
      w.db
        .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id, email, name, customer_id) VALUES ('pay-1', ?, 'api', ?, 900, 'USD', 'vid-1', 'sid-1', 'grace@example.org', 'Grace Hopper', 'cus_7')")
        .bind(site.id, now - 1000),
    ]);
  });
  afterAll(() => w.dispose());

  const asDevice = (p: string) => w.fetch(p, { headers: { cookie: '', authorization: `Bearer ${token}` } });

  itPro('refuses raw exports to a phone, even with VIEWER_PII on, and hides names, emails and user ids with PHONE_PII=0', async () => {
    for (const t of ['payments', 'sessions', 'events']) {
      const res = await asDevice(`/api/sites/${site.id}/export/${t}.csv?period=7d`);
      expect(res.status, t).toBe(403);
      expect((await res.json<any>()).error).toMatch(/phone token/);
    }
    const customers = await (await asDevice(`/api/sites/${site.id}/customers?period=7d`)).json<any[]>();
    expect(customers[0]).toMatchObject({ amount: 900, email: null, name: null, user_id: null });
    const profile = await (await asDevice(`/api/sites/${site.id}/visitors/vid-1`)).json<any>();
    expect(JSON.stringify(profile)).not.toMatch(/grace|Hopper|u-7|cus_7/i);
    // Aggregates still work, and the owner still exports.
    expect((await asDevice(`/api/sites/${site.id}/overview?period=7d`)).status).toBe(200);
    expect((await w.fetch(`/api/sites/${site.id}/export/payments.csv?period=7d`)).status).toBe(200);
  });

  it('stores a keyed hash of the IP for a wrong password, and the daily cron deletes old rows', async () => {
    const res = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'nope' }, headers: { cookie: '', 'cf-connecting-ip': '198.51.100.23' } });
    expect(res.status).toBe(401);
    const rows = (await w.db.prepare('SELECT ip, ts FROM login_failures').all<{ ip: string; ts: number }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain('198.51.100.23');
    // The same IP still counts toward its own lockout.
    for (let i = 0; i < 9; i++) await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'nope' }, headers: { cookie: '', 'cf-connecting-ip': '198.51.100.23' } });
    const locked = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'test-password' }, headers: { cookie: '', 'cf-connecting-ip': '198.51.100.23' } });
    expect(locked.status).toBe(429);
    const other = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'test-password' }, headers: { cookie: '', 'cf-connecting-ip': '198.51.100.24' } });
    expect(other.status).toBe(200);

    // A single wrong password that nobody follows up on is gone after the next daily run.
    const pruned = await pruneOldData(w.db, Date.now() + 61 * 60_000);
    expect(pruned.loginFailures).toBe(10);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM login_failures').first('n')).toBe(0);
  }, 60_000);
});

describe('privacy r3: Stripe import key timeout', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ stripe_webhook_secret: 'whsec_r3' });
  });
  afterAll(() => w.dispose());

  const idleRow = (siteId: string, updatedAt: number) =>
    w.db
      .prepare(
        `INSERT OR REPLACE INTO stripe_imports (site_id, stripe_key, status, since, cursor, cursor_ts, seen, recorded, skipped, error, started_at, updated_at)
         VALUES (?, 'rk_live_abcdefghijkl', 'running', ?, 'ch_cursor_9', ?, 40, 12, 28, NULL, ?, ?)`,
      )
      .bind(siteId, updatedAt - 300 * DAY, updatedAt - 30 * DAY, updatedAt - DAY, updatedAt)
      .run();

  it('the cron deletes the key of an import idle for over an hour, and leaves a fresh one', async () => {
    const other = await w.createSite();
    const now = Date.now();
    await idleRow(site.id, now - KEY_IDLE_MS - 60_000);
    await idleRow(other.id, now - 5 * 60_000);
    expect(await stopIdleImports(w.db, now)).toBe(1);
    const row = await w.db.prepare('SELECT status, stripe_key, error, cursor FROM stripe_imports WHERE site_id = ?').bind(site.id).first<any>();
    expect(row).toEqual({ status: 'stopped', stripe_key: null, error: STOPPED_MESSAGE, cursor: 'ch_cursor_9' });
    expect(await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(other.id).first('stripe_key')).toBe('rk_live_abcdefghijkl');
    // A second run writes nothing.
    expect(await stopIdleImports(w.db, now)).toBe(0);
  });

  it('reading the state stops an idle import too, and pasting the key again resumes at the cursor', async () => {
    await idleRow(site.id, Date.now() - 2 * KEY_IDLE_MS);
    const state = (await w.admin(`/api/sites/${site.id}/stripe-import`)).body;
    expect(state).toMatchObject({ status: 'stopped', error: STOPPED_MESSAGE, recorded: 12 });
    expect(state.stripe_key).toBeUndefined();
    expect(await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(site.id).first('stripe_key')).toBeNull();
    // A step without the key does nothing.
    expect((await w.admin(`/api/sites/${site.id}/stripe-import/step`, { method: 'POST' })).body.status).toBe('stopped');
    expect(stripeCalls).toEqual([]);

    const resumed = (await w.admin(`/api/sites/${site.id}/stripe-import`, { method: 'POST', json: { key: 'rk_live_newkey123456', months: 3 } })).body;
    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0]).toContain('starting_after=ch_cursor_9');
    expect(resumed).toMatchObject({ status: 'done', recorded: 12, seen: 40 });
    expect(await w.db.prepare('SELECT stripe_key FROM stripe_imports WHERE site_id = ?').bind(site.id).first('stripe_key')).toBeNull();
  });
});

describe('privacy r3: erase log', () => {
  let w: TestWorker;
  let viewerCookie = '';
  beforeAll(async () => {
    w = await startWorker({ VIEWER_PASSWORD: 'viewer-password' });
    const res = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '' } });
    viewerCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  });
  afterAll(() => w.dispose());

  it('records who handled each request and a note, keeps the log after a site delete, and lists every site', async () => {
    const site = await w.createSite({ name: 'Docs' });
    await w.db.prepare("INSERT INTO visitors (site_id, id, first_seen, email) VALUES (?, 'v-a', ?, 'a@example.org'), (?, 'v-b', ?, NULL)").bind(site.id, Date.now(), site.id, Date.now()).run();

    // The dashboard login, with a note.
    const one = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'a@example.org', note: 'Ticket 4411\nhandled by Ana' } });
    expect(one.body).toMatchObject({ ok: true, visitors: 1 });
    // A script with the site's API key.
    const api = await w.fetch('/api/v1/visitors/v-b?note=DSR%20via%20form', { method: 'DELETE', headers: { cookie: '', authorization: `Bearer ${site.api_key}` } });
    expect(api.status).toBe(200);
    expect((await w.fetch('/api/v1/erase', { method: 'POST', json: { user_id: 'u-none' }, headers: { cookie: '', authorization: 'Bearer rt_wrong' } })).status).toBe(401);
    expect((await w.fetch('/api/v1/erase', { method: 'POST', json: { user_id: 'u-none' }, headers: { cookie: '', authorization: `Bearer ${site.api_key}` } })).status).toBe(200);
    // The viewer can read the log, never erase.
    expect((await w.fetch(`/api/sites/${site.id}/erase`, { method: 'POST', json: { user_id: 'x' }, headers: { cookie: viewerCookie } })).status).toBe(403);

    const list = (await w.admin(`/api/sites/${site.id}/erasures`)).body;
    expect(list.map((e: any) => [e.method, e.handled_by, e.note])).toEqual(
      expect.arrayContaining([
        ['email', 'admin', 'Ticket 4411 handled by Ana'],
        ['visitor', 'api', 'DSR via form'],
        ['user_id', 'api', null],
      ]),
    );
    expect(JSON.stringify(list)).not.toMatch(/a@example|v-a|v-b|u-none/);
    const csv = await (await w.fetch(`/api/sites/${site.id}/erasures?format=csv`)).text();
    expect(csv.split('\r\n')[0]).toMatch(/,handled_by,note$/);

    // The site goes; its erase log stays, with its name, and shows in the deployment-wide list.
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { name: 'Docs site' } });
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' })).status).toBe(200);
    forgetSite(site.id);
    const kept = (await w.db.prepare('SELECT site_name FROM erasures WHERE site_id = ?').bind(site.id).all<any>()).results;
    expect(kept).toHaveLength(3);
    expect(kept.every((r) => r.site_name === `Docs site (${site.domain})`)).toBe(true);
    const all = (await w.admin('/api/erasures')).body;
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ site_id: site.id, site_name: `Docs site (${site.domain})`, deleted: true });
    expect((await w.fetch('/api/erasures', { headers: { cookie: viewerCookie } })).status).toBe(200);
    expect((await w.fetch('/api/erasures', { headers: { cookie: '' } })).status).toBe(401);
    const allCsv = await (await w.fetch('/api/erasures?format=csv')).text();
    expect(allCsv.split('\r\n')[0]).toMatch(/^time,site_id,site,site_deleted,method,/);
  });
});

describe('ops r3: share pages, no payments connected, refused webhooks, small products, previews', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
    resetBudgetForTests();
  });
  afterAll(() => w.dispose());

  it('tells search engines to skip share pages', async () => {
    const site = await w.createSite();
    const tok = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link' } })).body;
    for (const p of ['', '/overview?period=7d', '/badge.svg']) {
      const res = await w.fetch(`/api/share/${tok.token}${p}`, { headers: { cookie: '' } });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('x-robots-tag'), p).toBe('noindex, nofollow');
    }
    // A cached answer carries it too.
    expect((await w.fetch(`/api/share/${tok.token}/overview?period=7d`, { headers: { cookie: '' } })).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    // The page is a static file: _headers sets the header, and the page adds a robots meta tag.
    expect(fs.readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')).toMatch(/\/share\/\*\n\s+X-Robots-Tag: noindex, nofollow/);
    expect(fs.readFileSync(new URL('../src/dashboard/pages/SharePage.tsx', import.meta.url), 'utf8')).toContain("meta.name = 'robots'");
  });

  it('marks a site with no payment provider and no payment, on the site list and Home', async () => {
    const docs = await w.createSite({ domain: 'docs-nopay.example.com', name: 'Docs' });
    const shop = await w.createSite({ domain: 'shop-pay.example.com', name: 'Shop', stripe_webhook_secret: 'whsec_shop' });
    const api = await w.createSite({ domain: 'api-pay.example.com', name: 'API' });
    const flag = async (id: string) => (await w.admin('/api/sites')).body.find((s: any) => s.id === id).payments_connected;
    expect(await flag(docs.id)).toBe(false);
    expect(await flag(shop.id)).toBe(true);
    expect(await flag(api.id)).toBe(false);
    // A payment through the API, which needs no setup, turns it on.
    await w.fetch('/api/v1/payments', { method: 'POST', json: { transaction_id: 'p-api-1', amount: 9, currency: 'USD' }, headers: { cookie: '', authorization: `Bearer ${api.api_key}` } });
    expect(await flag(api.id)).toBe(true);
    const h = await home(w.db, { period: '7d' });
    const by = Object.fromEntries(h.sites.map((s) => [s.id, s.payments]));
    expect(by).toMatchObject({ [docs.id]: false, [shop.id]: true, [api.id]: true });
  });

  it('counts deliveries refused for a bad signature, shows them on Settings and Home, and alerts once a day', async () => {
    resetBudgetForTests();
    const site = await w.createSite({ domain: 'ls-refused.example.com', name: 'ShipKit', lemonsqueezy_secret: 'ls-secret-r3' });
    const ch = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', target: HOOK, alerts: { daily: false, weekly: false } } });
    expect(ch.body.alerts.webhook_refused).toBe(true);
    const deliver = () =>
      w.fetch(`/api/webhooks/lemonsqueezy/${site.id}`, { method: 'POST', body: '{"meta":{"event_name":"order_created"}}', headers: { cookie: '', 'x-signature': 'bad', 'content-type': 'application/json' } });

    w.takeRowsWritten();
    expect((await deliver()).status).toBe(401);
    await w.flush();
    // One row for the first refusal, and its alert inbox row (alert-events.ts); the next ones within 10 minutes wait in memory.
    expect(w.takeRowsWritten()).toBe(2);
    for (let i = 0; i < 3; i++) expect((await deliver()).status).toBe(401);
    await w.flush();
    expect(w.takeRowsWritten()).toBe(0);
    expect(sent.filter((s) => s.body.type === 'webhook_refused')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ provider: 'lemonsqueezy', refused: 1, title: 'Lemon Squeezy webhooks refused on ShipKit' }) }),
    ]);

    const now = Date.now();
    expect(await refusedWebhooks(w.db, now, site.id)).toEqual([expect.objectContaining({ siteId: site.id, provider: 'lemonsqueezy', count: 1 })]);
    const one = (await w.admin(`/api/sites/${site.id}`)).body;
    expect(one.refused_webhooks.lemonsqueezy).toMatchObject({ count: 1 });
    const h = await home(w.db, { period: '7d' }, now);
    const item = h.attention.find((a) => a.kind === 'webhook_refused');
    expect(item).toMatchObject({ siteId: site.id, link: 'settings' });
    expect(item!.text).toBe(
      "Lemon Squeezy: 1 delivery to ShipKit refused today for a bad signature. Check that the signing secret in the site's Settings, Payments matches the webhook in Lemon Squeezy.",
    );
    // A delivery with no secret set (400) or to an unknown site (404) is not a refusal.
    const bare = await w.createSite();
    expect((await w.fetch(`/api/webhooks/lemonsqueezy/${bare.id}`, { method: 'POST', body: '{}', headers: { cookie: '', 'x-signature': 'x' } })).status).toBe(400);
    await w.flush();
    expect(await refusedWebhooks(w.db, now, bare.id)).toEqual([]);
    // Deleting the site deletes its counts.
    await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' });
    expect(await refusedWebhooks(w.db, now, site.id)).toEqual([]);
    await w.admin(`/api/alerts/channels/${ch.body.id}`, { method: 'DELETE' });
  });

  it('alerts a small product after twice its longest gap, and leaves single sales and typed-in income alone', async () => {
    const now = Date.parse('2026-11-02T07:00:00Z');
    const zine = await w.createSite({ domain: 'zine-small.example.com', name: 'Zine Pack' });
    const pay = (siteId: string, provider: string, ts: number) =>
      w.db.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, kind) VALUES (?, ?, ?, ?, 500, 'USD', 'payment')").bind(crypto.randomUUID(), siteId, provider, ts);
    // Gumroad: 4 sales 6 to 9 days apart, the last 20 days ago. Longest gap 9 days: it waits 18, so at least 14 holds: 18.
    const last = now - 20 * DAY;
    await w.db.batch([pay(zine.id, 'gumroad', last), pay(zine.id, 'gumroad', last - 9 * DAY), pay(zine.id, 'gumroad', last - 15 * DAY), pay(zine.id, 'gumroad', last - 22 * DAY)]);
    // One Polar sale only, and income typed in by hand: neither has a rhythm to break.
    await w.db.batch([pay(zine.id, 'polar', now - 40 * DAY), pay(zine.id, 'income', now - 40 * DAY), pay(zine.id, 'income', now - 70 * DAY)]);

    expect(gapDaysNeeded(3)).toBe(14);
    expect(gapDaysNeeded(9)).toBe(18);
    expect(gapDaysNeeded(30)).toBe(60);
    const list = (await stoppedProviders(w.db, now)).filter((s) => s.siteId === zine.id);
    expect(list).toEqual([expect.objectContaining({ provider: 'gumroad', usual: 4, need: 18, days: 20, gap: 9 })]);
    expect(stoppedText(list[0])).toBe(
      "Gumroad has sent Zine Pack no payment for 20 days. Its longest gap between payments in the 90 days before was 9 days. Check the ping URL in Gumroad's settings.",
    );
    // Before 18 days it waits; after 60 days it gives up.
    expect((await stoppedProviders(w.db, last + 17 * DAY)).filter((s) => s.siteId === zine.id)).toEqual([]);
    expect((await stoppedProviders(w.db, last + 61 * DAY)).filter((s) => s.siteId === zine.id)).toEqual([]);
  });

  itPro('"Send" previews every alert type on a channel', async () => {
    const site = await w.createSite({ domain: 'preview.example.com', name: 'Preview Co' });
    const ch = (await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', target: HOOK, sites: [site.id] } })).body;
    for (const what of ALERT_KINDS) {
      sent = [];
      const res = await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST', json: { what } });
      expect(res.body, what).toMatchObject({ ok: true });
      expect(sent, what).toHaveLength(1);
      expect(sent[0].body.type, what).toBe(what);
      if (what !== 'weekly') {
        expect(sent[0].body.title, what).toMatch(/^Preview: /);
        expect(sent[0].body.preview, what).toBe(true);
      }
    }
    sent = [];
    await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST', json: {} });
    expect(sent[0].body).toMatchObject({ type: 'test', title: 'Test from FounderData' });
    // The refused-webhook preview names the channel's site.
    sent = [];
    await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST', json: { what: 'webhook_refused' } });
    expect(sent[0].body.text).toContain('to Preview Co refused today');
  });
});
