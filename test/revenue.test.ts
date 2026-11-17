import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_STORE_NO_SOURCE, home } from '../src/worker/home';
import { dayBucket, wholeDays } from '../src/worker/revenue';
import { mobileSummary } from '../src/worker/summary';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro, proModule } from './helpers/edition';

// Revenue = payments that are not App Store sales + App Store revenue (src/worker/revenue.ts). On a day Apple's
// report covers, the report counts the App Store sales and the App Store payment rows of that day stay out.
describe('revenue: Apple report and payments, counted once', () => {
  let w: TestWorker;
  let app: any; // EUR site with an app matched in App Store Connect
  let web: any; // USD site without an app
  const now = Date.parse('2026-10-29T12:00:00Z');
  const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
  // 10-21 and 10-22 are imported with rows, 10-23 is imported as a zero day, 10-27 is not imported.
  const D1 = '2026-10-21';
  const D2 = '2026-10-22';
  const ZERO = '2026-10-23';
  const OPEN = '2026-10-27';

  const pay = (id: string, site: any, provider: string, day: string, amount: number, currency: string, extra: { conv?: number; vid?: string; sid?: string } = {}) =>
    w.db
      .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, amount_conv, visitor_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, site.id, provider, at(day), amount, amount < 0 ? 'refund' : 'payment', currency, extra.conv ?? null, extra.vid ?? null, extra.sid ?? null)
      .run();
  let key = 0;
  const sale = (day: string, site: any, kind: string, units: number, price: number, currency: string) =>
    w.db
      .prepare(
        `INSERT INTO asc_sales (report_date, row_key, site_id, product_type, kind, units, proceeds, proceeds_currency, customer_price, customer_currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(day, `k${key++}`, site.id, kind === 'iap' ? 'IA1' : '1', kind, units, Math.abs(price) * 0.7, currency, price, currency)
      .run();

  beforeAll(async () => {
    w = await startWorker();
    app = await w.createSite({ domain: 'app-rev.invalid', currency: 'EUR', app_bundle_id: 'com.example.rev' });
    web = await w.createSite({ domain: 'web-rev.com', currency: 'USD' });
    await w.db.prepare("UPDATE sites SET asc_app_id = '600', asc_sku = 'Rev.App' WHERE id = ?").bind(app.id).run();
    await w.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, source, channel, referrer_domain)
         VALUES (?, 'rev-s1', 'rev-v1', ?, ?, 2, 'app-rev.invalid', 'Google', 'Organic Search', 'google.com')`,
      )
      .bind(app.id, at(D1) - 60_000, at(D1))
      .run();

    // Apple's report. Refund rows carry negative units and a negative customer price, as Apple sends them.
    await sale(D1, app, 'iap', 2, 4.99, 'EUR');
    await sale(D1, app, 'iap', -1, -4.99, 'EUR');
    await sale(D1, app, 'iap', 1, 5, 'USD'); // 4.00 EUR at 1.25 on D1
    await sale(D1, app, 'download', 5, 0, 'EUR'); // free downloads are not revenue
    await sale(D2, app, 'iap', 1, 5, 'USD'); // 2.50 EUR at the 2.00 stored for D2 only
    for (const [d, status] of [[D1, 'ok'], [D2, 'ok'], [ZERO, 'zero']]) {
      await w.db.prepare('INSERT INTO asc_import_days (report_date, status, rows, imported_at) VALUES (?, ?, 0, 0)').bind(d, status).run();
    }
    await w.db.prepare("INSERT OR REPLACE INTO fx_rates (day, currency, per_eur) VALUES (?, 'EUR', 1), (?, 'USD', 2)").bind(D2, D2).run();

    // Payment rows. The notification for the D1 sale is in the report too; the RevenueCat App Store row as well.
    await pay('apple_rev_1', app, 'app_store', D1, 499, 'EUR', { vid: 'rev-v1', sid: 'rev-s1' });
    await pay('apple_rev_rc', app, 'revenuecat', D1, 499, 'EUR');
    await pay('apple_rev_zero', app, 'app_store', ZERO, 499, 'EUR');
    // Not imported yet: the notification counts.
    await pay('apple_rev_2', app, 'app_store', OPEN, 999, 'USD', { conv: 799 });
    await pay('apple_rev_sandbox', app, 'app_store_sandbox', OPEN, 999, 'EUR');
    await pay('pi_rev_1', app, 'stripe', D1, 1000, 'EUR', { vid: 'rev-v1', sid: 'rev-s1' });
    await pay('pi_rev_web', web, 'stripe', D1, 1500, 'USD');
  });
  afterAll(() => w.dispose());

  // Report: 2 x 4.99 - 4.99 + 4.00 (D1) + 2.50 (D2) = 11.49 EUR, 4 units sold. Not imported: 7.99 EUR. Stripe: 10.00 EUR.
  const REPORT = 998 - 499 + 400 + 250;
  const APP_STORE = REPORT + 799;

  it('counts the report on imported days and payment rows on the others, never both, never sandbox', async () => {
    const body = await home(w.db, { period: '30d', tz: 'UTC' }, now);
    const site = body.sites.find((s) => s.id === app.id)!;
    expect(site.current.revenue).toEqual({ EUR: 1000 + APP_STORE });
    expect(site.current.appStoreRevenue).toEqual({ EUR: APP_STORE });
    // Purchases: Stripe, the open-day notification and Apple's 4 units sold.
    expect(site.current.payments).toBe(1 + 1 + 4);
    // New customers stay payment based: every non-renewal payment row, Apple's included.
    expect(site.current.customers).toBe(4);
    const other = body.sites.find((s) => s.id === web.id)!;
    expect(other.current.revenue).toEqual({ USD: 1500 });
    expect(other.current.appStoreRevenue).toEqual({});
    expect(body.totals.current.revenue).toEqual({ EUR: 1000 + APP_STORE, USD: 1500 });
  });

  it('puts each report day into the chart, so the chart adds up to the tile', async () => {
    const body = await home(w.db, { period: '30d', tz: 'UTC' }, now);
    const site = body.sites.find((s) => s.id === app.id)!;
    const byDay = Object.fromEntries(site.series.map((b) => [b.bucket, b.revenue]));
    expect(byDay[D1]).toBe(1000 + 998 - 499 + 400);
    expect(byDay[D2]).toBe(250);
    expect(byDay[ZERO]).toBe(0);
    expect(byDay[OPEN]).toBe(799);
    expect(site.series.reduce((n, b) => n + b.revenue, 0)).toBe(1000 + APP_STORE);
    expect(body.series.reduce((n, b) => n + (b.revenue.EUR ?? 0), 0)).toBe(1000 + APP_STORE);
  });

  it('adds an App Store row to the sources, so the panel adds up to the revenue tile', async () => {
    const body = await home(w.db, { period: '30d', tz: 'UTC' }, now);
    const google = body.sources.find((s) => s.label === 'Google')!;
    // Attribution stays per payment: the Stripe payment and the App Store notification credited to the visit.
    expect(google.revenue).toEqual({ EUR: 1000 + 499 });
    const rest = body.sources.find((s) => s.label === APP_STORE_NO_SOURCE)!;
    expect(rest).toMatchObject({ appStore: true, visitors: 0, customers: 0, revenue: { EUR: APP_STORE - 499 } });
    const eur = body.sources.reduce((n, s) => n + (s.revenue.EUR ?? 0), 0);
    expect(eur).toBe(body.totals.current.revenue.EUR);
  });

  it('applies the same definition on the site overview, by source and by provider', async () => {
    const q = 'period=custom&from=2026-10-01&to=2026-10-28';
    const overview = (await w.admin(`/api/sites/${app.id}/overview?${q}`)).body;
    expect(overview.current.revenue).toBe(1000 + APP_STORE);
    expect(overview.current.payments).toBe(6);
    expect(overview.series.reduce((n: number, b: any) => n + b.revenue, 0)).toBe(1000 + APP_STORE);

    const sources = (await w.admin(`/api/sites/${app.id}/breakdown?${q}&dim=source`)).body;
    expect(sources.find((r: any) => r.label === 'Google').revenue).toBe(1499);
    expect(sources.find((r: any) => r.label === APP_STORE_NO_SOURCE)).toMatchObject({ appStore: true, revenue: APP_STORE - 499 });
    expect(sources.reduce((n: number, r: any) => n + r.revenue, 0)).toBe(overview.current.revenue);
    // Not an attribution panel: no App Store row.
    const countries = (await w.admin(`/api/sites/${app.id}/breakdown?${q}&dim=country`)).body;
    expect(countries.some((r: any) => r.appStore)).toBe(false);

    const providers = (await w.admin(`/api/sites/${app.id}/revenue?${q}`)).body;
    const appStore = providers.filter((r: any) => r.provider === 'app_store');
    // The USD notification keeps its own line (paid in USD, converted); the report joins the EUR line.
    expect(appStore.find((r: any) => r.currency === 'EUR')).toMatchObject({ gross: 998 + 400 + 250, refunds: -499, net: REPORT, payments: 4, counted: true });
    expect(appStore.find((r: any) => r.currency === 'USD')).toMatchObject({ net: 999, netConverted: 799 });
    expect(providers.some((r: any) => r.provider === 'revenuecat')).toBe(false);
    const counted = providers.filter((r: any) => r.counted).reduce((n: number, r: any) => n + r.netConverted, 0);
    expect(counted).toBe(overview.current.revenue);

    // With a filter, revenue is what payments credited to matching visits brought: no report.
    const filtered = (await w.admin(`/api/sites/${app.id}/overview?${q}&filters=${encodeURIComponent('{"source":"Google"}')}`)).body;
    expect(filtered.current.revenue).toBe(1499);
  });

  itPro('counts the report on the Apps page and in the mobile summary', async () => {
    const { appsOverview } = await proModule('worker/appstats');
    const apps = await appsOverview(w.db, { period: '30d' }, now);
    const row = apps.apps.find((a: any) => a.id === app.id)!;
    // App Store payments and report; the Stripe payment came from a web visit, so it is not app revenue.
    expect(row.revenue).toEqual([{ currency: 'EUR', gross: 799 + 998 + 400 + 250, refunds: -499, net: APP_STORE, payments: 1 + 4, decimals: 2 }]);

    const summary = await mobileSummary(w.db, 'UTC', now, 'EUR');
    const site = summary.sites.find((s) => s.id === app.id)!;
    expect(site.periods['30d'].revenue).toBeCloseTo((1000 + APP_STORE) / 100, 6);
    expect(site.periods['30d'].purchases).toBe(6);
    const day = (d: string) => site.last30.find((x) => x.date === d)!.revenue;
    expect(day(D1)).toBeCloseTo(10 + 9.98 - 4.99 + 4, 6);
    expect(day(OPEN)).toBeCloseTo(7.99, 6);
    // EUR total: the app site plus 15.00 USD at 1.25.
    expect(summary.periods['30d'].revenueTotal).toBeCloseTo((1000 + APP_STORE) / 100 + 12, 2);
  });
});

describe('revenue: whole days and buckets', () => {
  it('uses the report only for days wholly inside the window', () => {
    const from = Date.parse('2026-10-28T12:00:00Z');
    expect(wholeDays({ from, to: from + 86_400_000 }, 'UTC')).toEqual([]);
    expect(wholeDays({ from, to: from + 2 * 86_400_000 }, 'UTC')).toEqual(['2026-10-29']);
    // Berlin midnight is 23:00 UTC the evening before (CET from 2026-10-25).
    expect(wholeDays({ from: Date.parse('2026-10-26T23:00:00Z'), to: Date.parse('2026-10-28T23:00:00Z') }, 'Europe/Berlin')).toEqual(['2026-10-27', '2026-10-28']);
  });

  it('puts a day into the bucket the chart uses', () => {
    expect(dayBucket('2026-10-29', 'hour')).toBe('2026-10-29T00:00');
    expect(dayBucket('2026-10-29', 'day')).toBe('2026-10-29');
    expect(dayBucket('2026-10-29', 'week')).toBe('2026-10-26');
    expect(dayBucket('2026-10-26', 'week')).toBe('2026-10-26');
    expect(dayBucket('2026-11-01', 'week')).toBe('2026-10-26');
    expect(dayBucket('2026-10-29', 'month')).toBe('2026-10');
  });
});
