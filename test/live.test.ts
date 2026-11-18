// GET /api/live, the live globe (src/worker/live.ts, docs/MOBILE-API.md section 9): auth, the online window, event
// kinds, caps, privacy (no stored ids, coordinates at one decimal) and an empty database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coarseCoord } from '../src/worker/collect';
import { liveData, MAX_EVENTS, MAX_PLACES, MAX_VISITORS, placesMinutesOf } from '../src/worker/live';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET = 'test-session-secret';

let w: TestWorker;
let shop: any;
let app: any;
let NOW = 0;

const session = (site: any, id: string, o: { started?: number; seen: number; host?: string; country?: string | null; city?: string | null; lat?: number | null; lon?: number | null; page?: string; device?: string; vid?: string }) =>
  w.db
    .prepare(
      `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page, source, channel, country, region, city, lat, lon, device)
       VALUES (?, ?, ?, ?, ?, 1, ?, '/', ?, 'Google', 'Organic Search', ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      site.id, id, o.vid ?? `vis-${id}`, o.started ?? o.seen - MIN, o.seen, o.host ?? site.domain, o.page ?? '/pricing',
      o.country === undefined ? 'DE' : o.country, o.city === undefined ? 'Berlin' : o.city, o.lat === undefined ? 52.5 : o.lat, o.lon === undefined ? 13.4 : o.lon, o.device ?? 'Desktop',
    );
const pay = (site: any, id: string, ts: number, o: { vid?: string; sid?: string; kind?: string; provider?: string; amount?: number; product?: string } = {}) =>
  w.db
    .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, product, email, name) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, 'buyer@example.com', 'Ada Buyer')`)
    .bind(id, site.id, o.provider ?? 'stripe', ts, o.amount ?? 4900, o.kind ?? 'payment', o.vid ?? null, o.sid ?? null, o.product ?? null);
const trial = (site: any, id: string, ts: number, o: { sid?: string; sandbox?: number } = {}) =>
  w.db
    .prepare(`INSERT INTO subscriptions (site_id, id, provider, status, product, trial_start, started_at, session_id, sandbox, updated_at) VALUES (?, ?, 'app_store', 'trialing', 'pro_yearly', ?, ?, ?, ?, ?)`)
    .bind(site.id, id, ts, ts, o.sid ?? null, o.sandbox ?? 0, ts);
const goal = (site: any, sid: string, ts: number, name: string) =>
  w.db.prepare(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES (?, ?, ?, ?, 'goal', ?, '/')`).bind(site.id, sid, `vis-${sid}`, ts, name);

beforeAll(async () => {
  w = await startWorker({ VIEWER_PASSWORD: 'viewer-password' });
});
afterAll(() => w.dispose());

describe('GET /api/live', () => {
  it('answers an empty database with zeros and empty lists', async () => {
    const live = await liveData(w.db, SECRET, Date.now());
    expect(live).toMatchObject({ windowMinutes: 5, online: 0, sites: [], visitors: [], events: [], places: [] });
  });

  it('fills the answer from the visits, payments, trials and goals', async () => {
    NOW = Date.now();
    shop = await w.createSite({ domain: 'live-shop.example' });
    expect((await w.admin(`/api/sites/${shop.id}/goal`, { method: 'PUT', json: { name: 'checkout_click' } })).status).toBe(200);
    app = await w.createSite({ domain: 'live-app.invalid', app_bundle_id: 'com.example.live' });
    await w.db.batch([
      // Online: seen in the last 5 minutes. A web visit, an app visit, and one more on the shop.
      session(shop, 's-web', { seen: NOW - MIN, lat: 52.5234, lon: 13.4115, device: 'Mobile' }),
      session(app, 's-app', { seen: NOW - 2 * MIN, host: 'ios:com.example.live', country: 'US', city: 'Austin', lat: 30.27, lon: -97.74, page: 'Paywall' }),
      session(shop, 's-web2', { seen: NOW - 3 * MIN, country: 'JP', city: null, lat: null, lon: null }),
      // Not online: seen exactly 5 minutes ago, or started more than 6 hours ago.
      session(shop, 's-edge', { seen: NOW - 5 * MIN }),
      session(shop, 's-long', { started: NOW - 7 * HOUR, seen: NOW - MIN }),
      // A customer: the web visitor paid weeks ago. A sandbox purchase makes no customer.
      pay(shop, 'p-old', NOW - 20 * 24 * HOUR, { vid: 'vis-s-web' }),
      pay(app, 'p-sandbox', NOW - 20 * 24 * HOUR, { vid: 'vis-s-app', provider: 'app_store_sandbox' }),
      // The last hour: a payment, a trial, a sign-up, the primary goal; and what stays out.
      pay(shop, 'p-new', NOW - 10 * MIN, { vid: 'vis-s-web', sid: 's-web', amount: 16900, product: 'Pro license' }),
      pay(shop, 'p-refund', NOW - 9 * MIN, { vid: 'vis-s-web', sid: 's-web', kind: 'refund', amount: -100 }),
      pay(shop, 'p-old-hour', NOW - 61 * MIN, { sid: 's-web' }),
      trial(app, 't-1', NOW - 5 * MIN, { sid: 's-app' }),
      trial(app, 't-sandbox', NOW - 4 * MIN, { sid: 's-app', sandbox: 1 }),
      goal(shop, 's-web', NOW - 20 * MIN, 'newsletter_signup'),
      goal(shop, 's-web', NOW - 21 * MIN, 'Sign up'),
      goal(shop, 's-web', NOW - 22 * MIN, 'checkout_click'),
      goal(shop, 's-web', NOW - 23 * MIN, 'signup_click'),
      goal(shop, 's-web', NOW - 24 * MIN, 'scroll_50'),
    ]);
    w.takeRowsWritten();
    const live = await liveData(w.db, SECRET, NOW);
    expect(w.takeRowsWritten()).toBe(0);

    expect(live.online).toBe(3);
    expect(live.sites).toEqual([
      { id: shop.id, name: 'Test', domain: 'live-shop.example', online: 2 },
      { id: app.id, name: 'Test', domain: 'live-app.invalid', online: 1 },
    ]);
    expect(live.visitors.map((v) => [v.siteId, v.platform, v.country, v.city, v.lat, v.lon, v.page, v.device, v.customer])).toEqual([
      [shop.id, 'web', 'DE', 'Berlin', 52.5, 13.4, '/pricing', 'mobile', true],
      [app.id, 'app', 'US', 'Austin', 30.3, -97.7, 'Paywall', 'desktop', false],
      [shop.id, 'web', 'JP', null, null, null, '/pricing', 'desktop', false],
    ]);
    expect(live.visitors[0]).toMatchObject({ source: 'Google', startedAt: NOW - 2 * MIN, lastSeenAt: NOW - MIN });

    expect(live.events.map((e) => [e.kind, e.label, e.amount, e.currency, e.country])).toEqual([
      ['trial', 'pro_yearly', null, null, 'US'],
      ['payment', 'Pro license', 16900, 'USD', 'DE'],
      ['signup', 'newsletter_signup', null, null, 'DE'],
      ['signup', 'Sign up', null, null, 'DE'],
      ['goal', 'checkout_click', null, null, 'DE'],
    ]);
    expect(live.events[1]).toMatchObject({ siteId: shop.id, ts: NOW - 10 * MIN, city: 'Berlin', lat: 52.5, lon: 13.4 });

    // Places over 24 hours: every visit above, by country and city, most visitors first.
    expect(live.places).toEqual([
      { country: 'DE', city: 'Berlin', lat: 52.5, lon: 13.4, visitors: 3 },
      { country: 'JP', city: null, lat: null, lon: null, visitors: 1 },
      { country: 'US', city: 'Austin', lat: 30.3, lon: -97.7, visitors: 1 },
    ]);
  });

  it('never returns a stored visitor or session id, a name or an email; ids are stable per visit', async () => {
    const a = await liveData(w.db, SECRET, NOW);
    const b = await liveData(w.db, SECRET, NOW);
    const json = JSON.stringify(a);
    for (const stored of ['s-web', 'vis-s-web', 's-app', 'vis-s-app', 'buyer@example.com', 'Ada Buyer']) expect(json).not.toContain(stored);
    expect(a.visitors.map((v) => v.id)).toEqual(b.visitors.map((v) => v.id));
    for (const v of a.visitors) expect(v.id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(a.visitors.map((v) => v.id)).size).toBe(a.visitors.length);
    // Another secret, other ids: the id cannot be recomputed from the session id alone.
    const other = await liveData(w.db, 'another-secret', NOW);
    expect(other.visitors[0].id).not.toBe(a.visitors[0].id);
    // Every coordinate has one decimal at most.
    expect(a.recent!.length).toBeGreaterThan(0);
    for (const v of a.recent!) expect(v.id).toMatch(/^[0-9a-f]{8}$/);
    // A visitor online has the same id in both lists.
    expect(a.recent!.map((v) => v.id)).toEqual(expect.arrayContaining(a.visitors.map((v) => v.id)));
    for (const p of [...a.visitors, ...a.events, ...a.places!, ...a.recent!]) {
      for (const c of [p.lat, p.lon]) if (c !== null) expect(Math.round(c * 10) / 10).toBe(c);
    }
  });

  it('skips places with places=0', async () => {
    const none = await liveData(w.db, SECRET, NOW, { places: false });
    expect(none.places).toBeNull();
    expect(none.recent).toBeNull();
    expect([none.recentCount, none.recentSites, none.recentRevenue, none.recentEvents]).toEqual([null, null, null, null]);
    const res = await w.fetch('/api/live?places=0');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('server-timing')).toMatch(/^total;dur=\d+;desc="Worker and D1", d1;dur=\d+;desc="D1 round trips in sequence, \d+ calls", sql;dur=[\d.]+;desc="\d+ rows read"$/);
    // The other first reads of a dashboard load carry it too.
    for (const p of ['/api/home?period=7d', '/api/auth/me', `/api/sites/${shop.id}/overview?period=7d`]) {
      expect((await w.fetch(p)).headers.get('server-timing'), p).toMatch(/^total;dur=\d+/);
    }
    expect((await res.json<any>()).places).toBeNull();
  });

  it('narrows places to the visitors seen in placesMinutes', async () => {
    await session(shop, 's-paris', { started: NOW - 3 * HOUR, seen: NOW - 2 * HOUR, country: 'FR', city: 'Paris', lat: 48.9, lon: 2.4 }).run();
    const day = await liveData(w.db, SECRET, NOW);
    expect(day.placesMinutes).toBe(1440);
    expect(day.places!.map((p) => p.country)).toContain('FR');
    const hour = await liveData(w.db, SECRET, NOW, { placesMinutes: 60 });
    expect(hour.placesMinutes).toBe(60);
    // Paris was seen two hours ago; the visit started 7 hours ago is out, as it is from the online count.
    expect(hour.places).toEqual([
      { country: 'DE', city: 'Berlin', lat: 52.5, lon: 13.4, visitors: 2 },
      { country: 'JP', city: null, lat: null, lon: null, visitors: 1 },
      { country: 'US', city: 'Austin', lat: 30.3, lon: -97.7, visitors: 1 },
    ]);
    // The window's visitors one by one, newest activity first: Paris in the day, not in the hour.
    // The visit started 7 hours ago counts here: it is not online, but it was seen in the day.
    expect(day.recent!.map((v) => [v.country, v.city])).toEqual([
      ['DE', 'Berlin'],
      ['DE', 'Berlin'],
      ['US', 'Austin'],
      ['JP', null],
      ['DE', 'Berlin'],
      ['FR', 'Paris'],
    ]);
    expect(day.recent).toContainEqual(day.visitors[0]);
    expect(day.recent!.find((v) => v.city === 'Paris')).toMatchObject({ siteId: shop.id, page: '/pricing', customer: false, lastSeenAt: NOW - 2 * HOUR });
    expect(hour.recent!.map((v) => v.city)).not.toContain('Paris');
    expect(hour.recent).toHaveLength(4);
    // The window's numbers: every visitor counted per site, payments per currency, and its events.
    expect([day.recentCount, hour.recentCount]).toEqual([6, 4]);
    expect(day.recentSites).toEqual([
      { id: shop.id, name: 'Test', domain: 'live-shop.example', visitors: 5 },
      { id: app.id, name: 'Test', domain: 'live-app.invalid', visitors: 1 },
    ]);
    expect(hour.recentSites!.map((s) => s.visitors)).toEqual([3, 1]);
    // The day has the payment from 61 minutes ago too; the refund and the sandbox purchase count in neither.
    expect(day.recentRevenue).toEqual([{ currency: 'USD', amount: 16900 + 4900, payments: 2 }]);
    expect(hour.recentRevenue).toEqual([{ currency: 'USD', amount: 16900, payments: 1 }]);
    expect(hour.recentEvents).toEqual(hour.events);
    expect(day.recentEvents!.filter((e) => e.kind === 'payment').map((e) => e.amount)).toEqual([16900, 4900]);
    // Online visitors and events do not depend on the window.
    expect(hour.visitors).toEqual(day.visitors);
    expect(hour.events).toEqual(day.events);
    await w.db.prepare(`DELETE FROM sessions WHERE id = 's-paris'`).run();

    const res = await w.fetch('/api/live?placesMinutes=30');
    expect((await res.json<any>()).placesMinutes).toBe(30);
    expect((await (await w.fetch('/api/live?places=0&placesMinutes=30')).json<any>()).placesMinutes).toBeNull();
    expect([placesMinutesOf(undefined), placesMinutesOf('abc'), placesMinutesOf('1'), placesMinutesOf('90.5'), placesMinutesOf('99999')]).toEqual([1440, 1440, 5, 90, 1440]);
  });

  itPro('needs a login: 401 logged out, 200 for the viewer and for a phone token', async () => {
    expect((await w.fetch('/api/live', { headers: { cookie: '' } })).status).toBe(401);
    expect((await w.fetch('/api/live', { headers: { cookie: '', authorization: 'Bearer not-a-token' } })).status).toBe(401);

    const login = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '' } });
    const viewer = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const asViewer = await w.fetch('/api/live', { headers: { cookie: viewer } });
    expect(asViewer.status).toBe(200);
    // The viewer login sees every site, as on the home page: there are no per-site logins.
    expect((await asViewer.json<any>()).sites.map((s: any) => s.id).sort()).toEqual([shop.id, app.id].sort());

    const phone = await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', name: 'Test phone', platform: 'ios' }, headers: { cookie: '' } });
    const token = (await phone.json<any>()).token;
    const asPhone = await w.fetch('/api/live', { headers: { cookie: '', authorization: `Bearer ${token}` } });
    expect(asPhone.status).toBe(200);
    const body = await asPhone.json<any>();
    expect(body.windowMinutes).toBe(5);
    expect(JSON.stringify(body)).not.toContain('buyer@example.com');
    // A read: the viewer and the phone may not write here.
    expect((await w.fetch('/api/live', { method: 'POST', headers: { cookie: viewer } })).status).toBe(403);
  });

  it('caps visitors at 150, events at 30 and places at 60, and counts every visitor online', async () => {
    const big = await w.createSite({ domain: 'live-big.example' });
    const t = Date.now();
    await w.db.batch([
      ...Array.from({ length: 160 }, (_, i) => session(big, `b${i}`, { seen: t - 1000 - i, country: `C${i % 70}`, city: `City ${i}` })),
      ...Array.from({ length: 40 }, (_, i) => pay(big, `bp${i}`, t - (i + 1) * MIN, { sid: `b${i}` })),
    ]);
    const live = await liveData(w.db, SECRET, t);
    expect(live.visitors).toHaveLength(MAX_VISITORS);
    expect(live.sites.find((s) => s.id === big.id)!.online).toBe(160);
    // Newest activity first.
    expect(live.visitors[0].lastSeenAt).toBeGreaterThanOrEqual(live.visitors[1].lastSeenAt);
    expect(live.events).toHaveLength(MAX_EVENTS);
    expect(live.events[0].ts).toBeGreaterThan(live.events[MAX_EVENTS - 1].ts);
    expect(live.places).toHaveLength(MAX_PLACES);
    expect(live.recent).toHaveLength(MAX_VISITORS);
    expect(live.recent![0].lastSeenAt).toBeGreaterThanOrEqual(live.recent![MAX_VISITORS - 1].lastSeenAt);
    // The count and the money cover everyone, past the caps of the lists.
    expect(live.recentSites!.find((s) => s.id === big.id)!.visitors).toBe(160);
    expect(live.recentCount).toBeGreaterThanOrEqual(160);
    expect(live.recentRevenue!.find((r) => r.currency === 'USD')!.payments).toBeGreaterThanOrEqual(40);
    expect(live.recentEvents).toHaveLength(MAX_EVENTS);
  });
});

describe('coordinates at collection', () => {
  it('rounds to one decimal and drops anything that is not a coordinate', () => {
    expect(coarseCoord('52.52437', 90)).toBe(52.5);
    expect(coarseCoord(-97.7431, 180)).toBe(-97.7);
    expect(coarseCoord('-0.04', 180)).toBe(0);
    expect(coarseCoord('91', 90)).toBeNull();
    expect(coarseCoord('abc', 90)).toBeNull();
    expect(coarseCoord(undefined, 90)).toBeNull();
    expect(coarseCoord('', 90)).toBeNull();
  });

  it('stores the trusted Vercel coordinates of a web visit at one decimal, in the same insert', async () => {
    const site = await w.createSite({ domain: 'live-geo.example' });
    w.env.TRUST_FORWARDED_FOR = '1';
    try {
      const res = await w.fetch('/api/event', {
        method: 'POST',
        json: { w: site.id, t: 'pageview', u: 'https://live-geo.example/' },
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36',
          'cf-connecting-ip': '198.51.100.44',
          'x-vercel-ip-country': 'DE',
          'x-vercel-ip-city': 'Berlin',
          'x-vercel-ip-latitude': '52.52437',
          'x-vercel-ip-longitude': '13.41053',
        },
      });
      expect(res.status).toBe(202);
      await w.flush();
      const row = await w.db.prepare('SELECT country, city, lat, lon FROM sessions WHERE site_id = ?').bind(site.id).first();
      expect(row).toEqual({ country: 'DE', city: 'Berlin', lat: 52.5, lon: 13.4 });
    } finally {
      delete w.env.TRUST_FORWARDED_FOR;
    }
  });
});
