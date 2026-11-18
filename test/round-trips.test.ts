// D1 round trips per read (lib/d1-trace.ts, docs/GUIDE.md "Server timing"). From a Worker far from its database each
// round trip costs a few hundred milliseconds, so the dashboard's and the phone's first reads are pinned here: home and
// a site's overview in 2, a phone's read in 1 more (its token), the phone's Home with Meta ads (yesterday=meta) as well. The numbers come from the Server-Timing header the
// routes send, on the full demo data (scripts/seed-demo.mjs): Apple's report, Search Ads, notes with verdicts, a primary goal,
// plus payments in other currencies and an app with only Apple's report, as on a production deployment.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

let w: TestWorker;
let phone = '';

beforeAll(async () => {
  w = await startWorker();
  // The demo data, generated into a temporary folder (the script writes .wrangler/seed.sql under its working directory).
  const dir = mkdtempSync(path.join(tmpdir(), 'fd-round-trips-'));
  try {
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/seed-demo.mjs')], { cwd: dir, stdio: 'ignore' });
    const sql = readFileSync(path.join(dir, '.wrangler/seed.sql'), 'utf8').split('\n').filter((l) => l.trim());
    for (const line of sql) await w.db.prepare(line.replace(/;\s*$/, '')).run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Shaped like a production deployment on top: a site in EUR paid in USD, JPY and CHF, and an app with Apple's report
  // over 400 days and no sessions (a silent app), its proceeds in USD, JPY and CHF and its buyers paying in four currencies.
  const now = Date.now();
  const DAY = 86_400_000;
  const day = (d: number) => new Date(now - d * DAY).toISOString().slice(0, 10);
  const stmts: D1PreparedStatement[] = [
    w.db.prepare("INSERT OR IGNORE INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('rt_eur', 'Euro shop', 'eur.example.com', 'UTC', 'EUR', 'k_rt_eur', ?)").bind(now - 420 * DAY),
    w.db
      .prepare("INSERT OR IGNORE INTO sites (id, name, domain, timezone, currency, api_key, app_bundle_id, asc_app_id, created_at) VALUES ('rt_app', 'Silent app', 'silent.invalid', 'UTC', 'EUR', 'k_rt_app', 'com.example.silent', '6460000001', ?)")
      .bind(now - 420 * DAY),
  ];
  ['USD', 'JPY', 'CHF'].forEach((cc, i) => {
    for (let d = 1; d < 400; d += 9) {
      stmts.push(
        w.db
          .prepare("INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency) VALUES (?, 'rt_eur', 'stripe', ?, ?, 'payment', ?)")
          .bind(`rt_p_${cc}_${d}`, now - d * DAY, 1000 + i * 100, cc),
      );
    }
  });
  // A Meta ad account on the euro site, billing in euros, with an ad visit that paid: the phone's Home reads it
  // (yesterday=meta) inside the first round trip.
  stmts.push(
    w.db.prepare("INSERT OR IGNORE INTO meta_settings (site_id, ad_account_id, updated_at) VALUES ('rt_eur', 'act_rt', 1)"),
    w.db.prepare("INSERT OR IGNORE INTO meta_accounts (id, name, currency, timezone) VALUES ('act_rt', 'Euro ads', 'EUR', 'UTC')"),
    w.db
      .prepare("INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, hostname, source, channel, ad_id) VALUES ('rt_eur', 'rt_ad', 'rt_v', ?, ?, 'eur.example.com', 'Instagram', 'Paid', 'rt_ad1')")
      .bind(now - 3 * DAY, now - 3 * DAY + 60_000),
    w.db.prepare("INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES ('rt_meta_p', 'rt_eur', 'stripe', ?, 4900, 'payment', 'EUR', 'rt_v', 'rt_ad')").bind(now - 2 * DAY),
  );
  for (let d = 1; d <= 7; d++) {
    stmts.push(
      w.db.prepare("INSERT OR IGNORE INTO meta_daily (ad_id, day, account_id, campaign_id, adset_id, spend, impressions, clicks) VALUES ('rt_ad1', ?, 'act_rt', 'c1', 's1', 12000000, 900, 30)").bind(day(d)),
    );
  }
  const apple = [['EUR', 'USD', 4.99], ['GBP', 'CHF', 4.49], ['JPY', 'JPY', 800], ['USD', 'USD', 4.99]] as const;
  for (let d = 1; d <= 400; d++) {
    for (const [cc, proceedsCc, price] of apple) {
      stmts.push(
        w.db
          .prepare(
            `INSERT OR IGNORE INTO asc_sales (report_date, row_key, site_id, sku, title, product_type, kind, units, proceeds, proceeds_currency, customer_price, customer_currency, country, device)
             VALUES (?, ?, 'rt_app', 'silent_pro', 'Pro', 'IAY', 'iap', ?, ?, ?, ?, ?, 'DE', 'iPhone')`,
          )
          .bind(day(d), `rt|${cc}`, 1 + (d % 5), Math.round(price * 85) / 100, proceedsCc, price, cc),
      );
    }
    stmts.push(w.db.prepare("INSERT OR IGNORE INTO asc_import_days (report_date, status, rows, imported_at) VALUES (?, 'ok', 4, ?)").bind(day(d), now));
  }
  // Miniflare's local proxy can drop a large batch's answer while other test files load it ("fetch failed",
  // ECONNRESET), even after the batch committed. Every seed row is INSERT OR IGNORE on a unique key, so sending the
  // batch again, up to 3 times, seeds each row once. Any other error fails at once.
  for (let i = 0; i < stmts.length; i += 200) {
    for (let attempt = 1; ; attempt++) {
      try {
        await w.db.batch(stmts.slice(i, i + 200));
        break;
      } catch (e) {
        if (attempt >= 3 || !/fetch failed/.test(String(e))) throw e;
      }
    }
  }
  const res = await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', name: 'Trips', platform: 'ios' }, headers: { cookie: '' } });
  phone = (await res.json<any>()).token;
}, 300_000);
afterAll(() => w.dispose());

/** The `d1` metric of Server-Timing: round trips one after another. Also checks the answer is a 200. */
async function trips(p: string, asPhone = false): Promise<number> {
  const res = await w.fetch(p, asPhone ? { headers: { cookie: '', authorization: `Bearer ${phone}` } } : {});
  expect(res.status, p).toBe(200);
  await res.text();
  const m = /(?:^|, )d1;dur=(\d+);desc="D1 round trips in sequence, (\d+) calls", sql;dur=[\d.]+;desc="\d+ rows read"/.exec(res.headers.get('server-timing') ?? '');
  expect(m, `${p}: ${res.headers.get('server-timing')}`).not.toBeNull();
  return Number(m![1]);
}

describe('D1 round trips', () => {
  const homes = ['30d', '7d', 'today', '90d', '12m', 'all']
    .map((p) => `/api/home?period=${p}`)
    .concat('/api/home?period=today&compare=sametime&parts=pulse', '/api/home?period=7d&yesterday=meta');
  const overviews = ['demo0001', 'demo0002', 'demo0003', 'demo0004', 'demo0005', 'rt_eur', 'rt_app'].map((id) => `/api/sites/${id}/overview?period=30d`);

  it('home and the overview: 2 each, once the isolate has its exchange rates', async () => {
    // A first read can fill the exchange rates it lacks (fx.ts rateLookup): one call to the rate API and its rows. It
    // also converts the payments waiting for it, 200 a pass.
    for (let i = 0; i < 2; i++) for (const p of [...homes, ...overviews]) await trips(p);
    for (const p of homes) expect(await trips(p), p).toBe(2);
    for (const p of overviews) expect(await trips(p), p).toBe(2);
  }, 60_000);

  itPro('a phone: 1 more, for its token', async () => {
    await trips('/api/mobile/summary', true);
    expect(await trips('/api/mobile/summary', true)).toBe(3);
    expect(await trips('/api/home?period=today&compare=sametime&parts=pulse', true)).toBe(3);
    expect(await trips('/api/home?period=30d', true)).toBe(3);
    // The phone's full Home with the Meta ads block, a site with a Meta ad account included.
    expect(await trips('/api/home?period=7d&yesterday=meta', true)).toBe(3);
  }, 60_000);

  it('the Meta ads block is there and costs no round trip of its own', async () => {
    const res = await w.fetch('/api/home?period=7d&yesterday=meta');
    const body = await res.json<any>();
    expect(body.sinceYesterday.meta).toMatchObject({ sites: ['rt_eur'], customers: 1, periodSpend: { EUR: 8400 } });
    expect(await trips('/api/home?period=7d&yesterday=meta')).toBe(2);
  });

  itPro("Home's Growth row: its own request, 2 round trips at most, 3 with spend in another currency", async () => {
    // The sites and the reporting timezone, then spend, Search Console and the AI counts together (pro/worker/growth.ts).
    for (const p of ['30d', '7d', '12m']) expect(await trips(`/api/home/growth?period=${p}`)).toBeLessThanOrEqual(2);
    // Spend sent in dollars for the euro site: the exchange rates are a third round trip, as on get_portfolio.
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await w.db
      .prepare(
        `INSERT INTO ad_spend (site_id, day, channel, account_id, campaign_id, adgroup_id, ad_id, campaign_name, spend, currency, origin, updated_at)
         VALUES ('rt_eur', ?, 'google_ads', '', 'rt_usd', '', '', 'Dollars', 10000000, 'USD', 'api', 0)`,
      )
      .bind(day)
      .run();
    try {
      for (const p of ['30d', '12m']) expect(await trips(`/api/home/growth?period=${p}`)).toBe(3);
    } finally {
      await w.db.prepare("DELETE FROM ad_spend WHERE site_id = 'rt_eur' AND campaign_id = 'rt_usd'").run();
    }
  });

  it('the site list and the live globe: 1', async () => {
    expect(await trips('/api/sites')).toBe(1);
    expect(await trips('/api/live?places=0')).toBe(1);
    expect(await trips('/api/live')).toBe(1);
  });

  it('a payment waiting for conversion adds its own round trips to that read only', async () => {
    const site = (await w.db.prepare("SELECT id FROM sites WHERE id = 'demo0001'").first<{ id: string }>())!;
    await w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency) VALUES ('rt_eur_1', ?, 'stripe', ?, 1000, 'payment', 'EUR')")
      .bind(site.id, Date.now() - 3_600_000)
      .run();
    // The scan, the day's rate, then the update, before the numbers.
    expect(await trips('/api/home?period=30d')).toBeGreaterThan(2);
    expect(await w.db.prepare("SELECT amount_conv FROM payments WHERE id = 'rt_eur_1'").first('amount_conv')).toBe(1250);
    expect(await trips('/api/home?period=30d')).toBe(2);
  }, 60_000);
});
