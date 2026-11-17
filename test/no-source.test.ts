import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetSite } from '../src/worker/env';
import { APP_STORE_NO_SOURCE, NO_SOURCE, home } from '../src/worker/home';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

// Every panel that splits revenue by where it came from adds up to the Revenue tile: payments with no linked visit
// sit in "No source", App Store revenue no linked payment explains in "App Store, no source", and a payment credited
// to a visit from before the period still counts for that visit's source.
describe('source panels add up to the Revenue tile', () => {
  let w: TestWorker;
  let site: any;
  const now = Date.parse('2026-10-29T12:00:00Z');
  const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
  const OLD = '2026-09-15'; // before both periods
  const REPORT_DAY = '2026-10-21'; // imported from Apple
  const OPEN = '2026-10-22'; // not imported

  const session = (id: string, day: string, source: string, channel: string, domain: string | null, campaign: string | null = null) =>
    w.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, source, channel, referrer_domain, utm_campaign)
         VALUES (?, ?, ?, ?, ?, 1, 'panels.example', ?, ?, ?, ?)`,
      )
      .bind(site.id, id, `v-${id}`, at(day), at(day), source, channel, domain, campaign)
      .run();
  const pay = (id: string, provider: string, day: string, amount: number, sessionId: string | null) =>
    w.db
      .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, site.id, provider, at(day), amount, amount < 0 ? 'refund' : 'payment', 'EUR', sessionId ? `v-${sessionId}` : null, sessionId)
      .run();

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'panels.example', currency: 'EUR', app_bundle_id: 'com.example.panels' });
    await w.db.prepare("UPDATE sites SET asc_app_id = '700', asc_sku = 'Panels' WHERE id = ?").bind(site.id).run();
    // Visits from before the period that paid inside it, and twelve sources that only sent visitors.
    await session('old-reddit', OLD, 'Reddit', 'Social', 'reddit.com', 'launch');
    await session('old-bing', OLD, 'Bing', 'Organic Search', 'bing.com');
    await session('new-google', '2026-10-20', 'Google', 'Organic Search', 'google.com');
    for (let i = 0; i < 12; i++) await session(`only-visits-${i}`, '2026-10-20', `Site ${i}`, 'Referral', `site${i}.example`);

    await pay('pi_panels_reddit', 'stripe', '2026-10-20', 2000, 'old-reddit');
    await pay('pi_panels_google', 'stripe', '2026-10-20', 1000, 'new-google');
    await pay('stripe_refund_panels_bing', 'stripe', '2026-10-20', -200, 'old-bing'); // its payment was before the period
    await pay('pi_panels_unlinked', 'stripe', '2026-10-20', 700, null);
    await pay('dodo_panels_unlinked', 'dodo', '2026-10-20', 300, null);
    await pay('pi_panels_lost_session', 'stripe', '2026-10-20', 100, 'gone'); // the visit was deleted
    await pay('apple_panels_open', 'app_store', OPEN, 499, null);
    await w.db
      .prepare(
        `INSERT INTO asc_sales (report_date, row_key, site_id, product_type, kind, units, proceeds, proceeds_currency, customer_price, customer_currency)
         VALUES (?, 'panels-1', ?, 'IA1', 'iap', 1, 3.49, 'EUR', 4.99, 'EUR')`,
      )
      .bind(REPORT_DAY, site.id)
      .run();
    await w.db.prepare("INSERT INTO asc_import_days (report_date, status, rows, imported_at) VALUES (?, 'ok', 1, 0)").bind(REPORT_DAY).run();
  });
  afterAll(() => w.dispose());

  const TILE = 2000 + 1000 - 200 + 700 + 300 + 100 + 499 + 499;

  it('home: the sources column adds up to the revenue tile', async () => {
    const body = await home(w.db, { period: '30d', tz: 'UTC' }, now);
    const tile = body.sites.find((s) => s.id === site.id)!.current.revenue.EUR;
    expect(tile).toBe(TILE);
    const by = (label: string) => body.sources.find((s) => s.label === label);
    expect(by('Reddit')).toMatchObject({ visitors: 0, customers: 1, revenue: { EUR: 2000 }, channel: 'Social' });
    expect(by('Bing')).toMatchObject({ revenue: { EUR: -200 } });
    expect(by(NO_SOURCE)).toMatchObject({ noVisit: true, sites: 1, revenue: { EUR: 700 + 300 + 100 } });
    expect(by(APP_STORE_NO_SOURCE)).toMatchObject({ appStore: true, revenue: { EUR: 499 + 499 } });
    expect(body.sources.reduce((n, s) => n + (s.revenue.EUR ?? 0), 0)).toBe(tile);
  }, 60_000);

  it('site dashboard: every attribution panel adds up to the revenue tile', async () => {
    const q = 'period=custom&from=2026-10-01&to=2026-10-28';
    const overview = (await w.admin(`/api/sites/${site.id}/overview?${q}`)).body;
    expect(overview.current.revenue).toBe(TILE);
    for (const dim of ['source', 'channel', 'referrer', 'campaign', 'utm_source']) {
      const rows = (await w.admin(`/api/sites/${site.id}/breakdown?${q}&dim=${dim}`)).body;
      expect(rows.find((r: any) => r.label === NO_SOURCE)).toMatchObject({ noVisit: true, revenue: 1100, visitors: 0 });
      expect(rows.reduce((n: number, r: any) => n + r.revenue, 0), dim).toBe(TILE);
    }
    // Not an attribution panel, and not with a filter: no extra rows.
    const countries = (await w.admin(`/api/sites/${site.id}/breakdown?${q}&dim=country`)).body;
    expect(countries.some((r: any) => r.noVisit || r.appStore)).toBe(false);
    const filtered = (await w.admin(`/api/sites/${site.id}/breakdown?${q}&dim=source&filters=${encodeURIComponent('{"channel":"Social"}')}`)).body;
    expect(filtered.some((r: any) => r.noVisit || r.appStore)).toBe(false);
  }, 60_000);

  itPro("get_portfolio's attribution coverage equals get_breakdown's for the same site and period", async () => {
    const key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'coverage', scopes: ['read', 'read:revenue'] } })).body.key as string;
    const read = async (path: string) => (await w.fetch(path, { headers: { authorization: `Bearer ${key}` } })).json<any>();
    // All time from September, so the October fixture stays in range whatever day the test runs.
    await w.db.prepare('UPDATE sites SET created_at = ? WHERE id = ?').bind(at('2026-09-01'), site.id).run();
    forgetSite(site.id);
    const breakdown = await read(`/api/v1/stats/breakdown?site=${site.id}&dim=channel&period=all&tz=UTC`);
    const portfolio = await read('/api/v1/portfolio?period=all&tz=UTC');
    const row = portfolio.sites.find((s: any) => s.id === site.id);
    // The report day's 499 and the 499 App Store payment on a day Apple has not reported, which no visit explains.
    expect(breakdown.attribution.app_store_no_source).toBe(499 + 499);
    expect(row.attribution).toEqual(breakdown.attribution);
  }, 60_000);
});
