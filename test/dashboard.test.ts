import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertPayments } from '../src/worker/fx';
import { startWorker, type TestWorker } from './helpers/worker';

describe('dashboard: platform, app version and revenue per provider', () => {
  let w: TestWorker;
  let site: any;
  const q = (path: string, filters?: Record<string, string>) =>
    w.admin(`/api/sites/${site.id}/${path}${path.includes('?') ? '&' : '?'}period=today${filters ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : ''}`);

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'stories.example.com', app_bundle_id: 'com.example.stories', currency: 'EUR' });
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
    for (const [vid, sid] of [['web-visitor-1', 'web-session-1'], ['web-visitor-2', 'web-session-2']]) {
      await w.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': ua },
        body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://stories.example.com/', r: '', vid, sid }),
      });
    }
    const app = (vid: string, sid: string, version: string) =>
      w.fetch('/api/app/events', {
        method: 'POST',
        body: JSON.stringify({
          w: site.id,
          vid,
          ctx: { bundle_id: 'com.example.stories', app_version: version, build: '12', os_version: '26.0', device: 'iPhone16,2' },
          events: [{ t: 'session_start', sid }, { t: 'screen', sid, n: 'Home' }],
        }),
      });
    await app('app-install-1', 'app-session-1', '2.0.0');
    await app('app-install-2', 'app-session-2', '2.1.0');
    await app('app-install-3', 'app-session-3', '2.1.0');
    const now = Date.now();
    const pay = (id: string, provider: string, amount: number, currency: string, kind = 'payment', vid = 'web-visitor-1', sid = 'web-session-1') =>
      w.db
        .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, site.id, provider, now, amount, kind, currency, vid, sid)
        .run();
    await pay('pi_dash_1', 'stripe', 4900, 'EUR');
    await pay('stripe_refund_ch_dash', 'stripe', -900, 'EUR', 'refund');
    await pay('apple_dash_1', 'app_store', 999, 'EUR', 'payment', 'app-install-1', 'app-session-1');
    await pay('apple_dash_2', 'app_store', 1299, 'USD', 'payment', 'app-install-2', 'app-session-2');
    await pay('apple_dash_3', 'app_store_sandbox', 999, 'EUR', 'payment', 'app-install-3', 'app-session-3');
    // recordPayment converts a payment in another currency when it stores it; these rows skip it.
    await convertPayments(w.db);
  });
  afterAll(() => w.dispose());

  it('splits visitors into Web and iOS, and filters by platform', async () => {
    const rows = (await q('breakdown?dim=platform')).body;
    expect(Object.fromEntries(rows.map((r: any) => [r.label, r.visitors]))).toEqual({ Web: 2, iOS: 3 });
    // 999 EUR + 12.99 USD at 1.25 USD per EUR (10.39 EUR).
    expect(rows.find((r: any) => r.label === 'iOS').revenue).toBe(999 + 1039);
    expect(rows.find((r: any) => r.label === 'Web').revenue).toBe(4000);
    const ios = (await q('overview', { platform: 'iOS' })).body;
    expect(ios.current.visitors).toBe(3);
    expect(ios.current.revenue).toBe(999 + 1039);
  });

  it('lists app versions (app sessions only) and filters by one', async () => {
    const rows = (await q('breakdown?dim=app_version')).body;
    expect(rows.map((r: any) => [r.label, r.visitors])).toEqual([
      ['2.1.0 (12)', 2],
      ['2.0.0 (12)', 1],
    ]);
    expect((await q('overview', { app_version: '2.0.0 (12)' })).body.current.visitors).toBe(1);
  });

  it('counts revenue in the site currency, other currencies converted, without sandbox purchases', async () => {
    const o = (await q('overview')).body;
    expect(o.current.revenue).toBe(4900 - 900 + 999 + 1039);
  });

  it('reports revenue per provider and currency, converted to the site currency', async () => {
    const rows = (await q('revenue')).body;
    const by = (p: string, c: string) => rows.find((r: any) => r.provider === p && r.currency === c);
    expect(by('stripe', 'EUR')).toMatchObject({ gross: 4900, refunds: -900, net: 4000, payments: 1, counted: true, decimals: 2 });
    expect(by('app_store', 'EUR')).toMatchObject({ net: 999, counted: true });
    expect(by('app_store', 'USD')).toMatchObject({ net: 1299, netConverted: 1039, counted: true });
    expect(by('app_store_sandbox', 'EUR')).toMatchObject({ net: 999, counted: false });
    expect(by('stripe', 'EUR')).toMatchObject({ netConverted: 4000 });
    const iosOnly = (await q('revenue', { platform: 'iOS' })).body;
    expect(iosOnly.some((r: any) => r.provider === 'stripe')).toBe(false);
  });

  it('gives Journey rows their provider', async () => {
    const rows = (await q('customers')).body;
    expect(rows.find((r: any) => r.id === 'apple_dash_2')).toMatchObject({ provider: 'app_store', currency: 'USD' });
  });
});
