import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetSite } from '../src/worker/env';
import { home, homePulse, revenueBasis } from '../src/worker/home';
import { dayInTz } from '../src/worker/lib/time';
import { pickTimezone } from '../src/worker/reporting';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

/**
 * One number per metric: web Home, the iPhone's Home (the same GET /api/home), a site's overview, GET /api/v1/portfolio
 * and GET /api/v1/weekly agree to the cent on revenue and exactly on visitors over the same window, when they count
 * days in the same timezone (the reporting timezone, src/worker/reporting.ts).
 *
 * The fixture puts visits and payments in the evening and around midnight New York time every day, so a window counted in UTC or in
 * the viewer's timezone would catch other rows than one counted in America/New_York.
 */
describe('one number per metric across Home, site pages and the read API', () => {
  let w: TestWorker;
  let shop: any;
  let app: any;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  beforeAll(async () => {
    w = await startWorker();
    shop = await w.createSite({ domain: 'shop-consistency.com', timezone: 'America/New_York', currency: 'USD' });
    app = await w.createSite({ domain: 'app-consistency.com', timezone: 'America/New_York', currency: 'USD', app_bundle_id: 'com.example.consistency' });
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    const session = (site: any, id: string, vid: string, ts: number) =>
      w.db
        .prepare(
          `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, entry_page, source, channel, browser)
           VALUES (?, ?, ?, ?, ?, 2, '/', 'Google', 'Organic Search', 'Chrome')`,
        )
        .bind(site.id, id, vid, ts, ts + 60_000);
    const pay = (site: any, id: string, provider: string, ts: number, amount: number, vid: string | null, sid: string | null) =>
      w.db
        .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, site.id, provider, ts, amount, amount < 0 ? 'refund' : 'payment', 'USD', vid, sid);
    // 45 days back: 02:30 UTC is the evening before in New York, 04:30 UTC is 23:30 or 00:30 there (daylight saving).
    const today = Math.floor(now / DAY) * DAY;
    for (let d = 1; d <= 45; d++) {
      for (const [k, at] of [
        ['a', today - d * DAY + 2.5 * HOUR],
        ['b', today - d * DAY + 4.5 * HOUR],
        ['c', today - d * DAY + 15 * HOUR],
      ] as const) {
        if (at >= now) continue;
        const sid = `s-${d}-${k}`;
        const vid = `v-${d}-${k}`;
        stmts.push(session(shop, sid, vid, at), session(app, `a${sid}`, `a${vid}`, at));
        stmts.push(pay(shop, `pi-${d}-${k}`, 'stripe', at + 1000, 1000 + d * 7 + k.charCodeAt(0), vid, sid));
        stmts.push(pay(app, `as-${d}-${k}`, 'app_store', at + 1000, 499 + d, `a${vid}`, `a${sid}`));
      }
      // A payment with no linked visit, a refund, and a web payment on the app's site.
      stmts.push(pay(shop, `nolink-${d}`, 'stripe', today - d * DAY + 4.75 * HOUR, 2500, null, null));
      if (d % 5 === 0) stmts.push(pay(shop, `re-${d}`, 'stripe', today - d * DAY + 4.6 * HOUR, -900, null, null));
      if (d % 3 === 0) stmts.push(pay(app, `web-${d}`, 'dodo', today - d * DAY + 5.6 * HOUR, 1999, null, null));
    }
    for (let i = 0; i < stmts.length; i += 50) await w.db.batch(stmts.slice(i, i + 50));
  });
  afterAll(() => w.dispose());

  // Apple Search Ads for the app: a campaign, spend on each of the last 41 days in New York (today too, which Apple never
  // has, so a window that ends today instead of yesterday catches it), and installs from the campaign, every other one paid.
  const APP_ID = '6450000999';
  const CAMPAIGN = '1874320999';
  const spendOn = (d: number) => (900 + d * 37) * 10_000; // micros: $9.00 + $0.37 a day back
  beforeAll(async () => {
    await w.db.prepare('UPDATE sites SET asc_app_id = ? WHERE id = ?').bind(APP_ID, app.id).run();
    forgetSite(app.id);
    const now = Date.now();
    const today = dayInTz(now, 'America/New_York');
    const day = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) - d * DAY).toISOString().slice(0, 10);
    const stmts: D1PreparedStatement[] = [w.db.prepare(`INSERT INTO asa_names (kind, id, name, parent) VALUES ('campaign', ?, 'Consistency US', ?)`).bind(CAMPAIGN, APP_ID)];
    for (let d = 0; d <= 40; d++) {
      stmts.push(
        w.db.prepare(`INSERT INTO asa_daily (day, campaign, keyword, spend, currency, taps, installs, impressions) VALUES (?, ?, '', ?, 'USD', 10, 2, 100)`).bind(day(d), CAMPAIGN, spendOn(d)),
      );
      // 18:00 UTC is the afternoon in New York, so the session falls on day(d) there.
      const at = Date.parse(`${day(d)}T18:00:00Z`);
      if (at >= now) continue;
      stmts.push(
        w.db
          .prepare(
            `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, entry_page, hostname, source, channel, utm_campaign)
             VALUES (?, ?, ?, ?, ?, 1, '/', 'ios:com.example.consistency', 'Apple Search Ads', 'Paid', ?)`,
          )
          .bind(app.id, `asa-${d}`, `asa-v-${d}`, at, at + 60_000, CAMPAIGN),
      );
      if (d % 2 === 0)
        stmts.push(
          w.db
            .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, 'app_store', ?, ?, 'payment', 'USD', ?, ?)`)
            .bind(`asa-p-${d}`, app.id, at + 5_000, 2999 + d, `asa-v-${d}`, `asa-${d}`),
        );
    }
    await w.db.batch(stmts);
  });

  const overview = async (site: any, q: string) => (await w.admin(`/api/sites/${site.id}/overview?${q}`)).body;
  const homeOf = async (q = 'period=30d') => (await w.admin(`/api/home?${q}`)).body;

  it('defaults to the timezone every site shares', async () => {
    const { body } = await w.admin('/api/settings/reporting-timezone');
    expect(body).toMatchObject({ timezone: 'America/New_York', source: 'sites', saved: null, differ: [] });
    const h = await homeOf();
    expect(h.tz).toBe('America/New_York');
    expect(h.tzSource).toBe('sites');
  });

  itPro('Home, the site overview and /api/v1/portfolio agree over the same period', async () => {
    // Each site's first visit and first payment: the oldest session of either site.
    const firstData = (await w.db.prepare('SELECT MIN(started_at) AS t FROM sessions WHERE site_id IN (?, ?)').bind(shop.id, app.id).first<{ t: number }>())!.t;
    let lateSeen = 0;
    for (const period of ['7d', '30d', 'yesterday']) {
      const h = await homeOf(`period=${period}`);
      const p = (await w.admin(`/api/v1/portfolio?period=${period}`)).body;
      for (const site of [shop, app]) {
        const o = await overview(site, `period=${period}`);
        const row = h.sites.find((s: any) => s.id === site.id);
        const pf = p.sites.find((s: any) => s.id === site.id);
        expect(o.current.visitors).toBeGreaterThan(0);
        expect(row.current.visitors).toBe(o.current.visitors);
        expect(row.previous.visitors).toBe(o.previous.visitors);
        expect(row.current.revenue.USD).toBe(o.current.revenue);
        expect(row.previous.revenue.USD ?? 0).toBe(o.previous.revenue);
        expect(pf.visitors).toBe(o.current.visitors);
        expect(pf.revenue).toBe(o.current.revenue);
        // The portfolio says null, with a reason, exactly when the site's data started after the period before began:
        // the fixture's first visit and first payment are 45 days back, so 30d has no full period before and 7d has.
        const late = firstData > Date.parse(p.previous_from);
        expect(late).toBe(period === '30d');
        if (late) {
          expect(pf).toMatchObject({ visitors_previous: null, revenue_previous: null });
          expect(pf.previous_reason).toMatch(/^Visits are recorded since \d{4}-\d{2}-\d{2}, .* Revenue is recorded since \d{4}-\d{2}-\d{2}, /);
          lateSeen++;
        } else {
          expect(pf.visitors_previous).toBe(o.previous.visitors);
          expect(pf.revenue_previous).toBe(o.previous.revenue);
          expect(pf.previous_reason).toBeNull();
        }
      }
      expect(p.timezone).toBe('America/New_York');
      expect(p.totals.revenue.USD).toBe(h.totals.current.revenue.USD);
      expect(p.totals.visitors).toBe(h.totals.current.visitors);
    }
    // Both sites hit the null branch once, for 30d.
    expect(lateSeen).toBe(2);
  });

  it("the phone's Pulse grid (parts=pulse) shows the full Home totals over the same window, and both charts add up to them", async () => {
    // Trials: unpaid, so MRR stays as the MRR test below expects. One every 3 days, a sandbox one that never counts.
    const now = Date.now();
    const trial = (id: string, ts: number, sandbox = 0) =>
      w.db
        .prepare(`INSERT INTO subscriptions (site_id, id, provider, status, trial_start, started_at, sandbox, updated_at) VALUES (?, ?, 'app_store', 'trialing', ?, ?, ?, ?)`)
        .bind(app.id, id, ts, ts, sandbox, ts);
    await w.db.batch([...Array.from({ length: 15 }, (_, i) => trial(`pulse-tr-${i}`, now - i * 3 * DAY - 2 * HOUR)), trial('pulse-tr-sb', now - HOUR, 1)]);
    expect((await homeOf('period=30d&parts=pulse')).totals.current.trials).toBe(10);
    // The route serves the Pulse part.
    const route = await homeOf('period=today&compare=sametime&parts=pulse');
    expect(route).toMatchObject({ parts: 'pulse', compare: 'sametime', tz: 'America/New_York' });
    expect(route.sites).toBeUndefined();
    // The same moment for both reads, so the windows are the same to the millisecond.
    for (const q of [{ period: 'today', compare: 'sametime' }, { period: 'today' }, { period: '7d' }, { period: '30d' }, { period: 'yesterday' }]) {
      const at = Date.now();
      const full = await home(w.db, q, at);
      const pulse = await homePulse(w.db, q, at);
      expect(pulse.parts).toBe('pulse');
      expect([pulse.range, pulse.previousRange, pulse.tz, pulse.compare]).toEqual([full.range, full.previousRange, full.tz, full.compare]);
      expect(pulse.totals).toEqual(full.totals);
      expect(pulse.series).toEqual(full.series);
      expect(pulse.previousSeries).toEqual(full.previousSeries);
      const sum = (points: any[], pick: (p: any) => number) => points.reduce((n, p) => n + pick(p), 0);
      // Today and yesterday can be empty just after midnight in New York, so only the longer windows must hold revenue.
      if (q.period === '7d' || q.period === '30d') expect(full.totals.current.revenue.USD).toBeGreaterThan(0);
      expect(sum(full.series, (p) => p.revenue.USD ?? 0)).toBe(full.totals.current.revenue.USD ?? 0);
      expect(sum(full.previousSeries, (p) => p.revenue.USD ?? 0)).toBe(full.totals.previous.revenue.USD ?? 0);
      expect(sum(full.series, (p) => p.customers)).toBe(full.totals.current.customers);
      expect(sum(full.series, (p) => p.trials)).toBe(full.totals.current.trials);
    }
    // Today against yesterday up to the same time holds yesterday's evening rows out.
    const same = await homeOf('period=today&compare=sametime&parts=pulse');
    const whole = await homeOf('period=yesterday&parts=pulse');
    expect(same.previousRange.from).toBe(whole.range.from);
    expect(same.totals.previous.revenue.USD ?? 0).toBeLessThanOrEqual(whole.totals.current.revenue.USD ?? 0);
  });

  itPro('Apple Search Ads spend, cost per paid and ROAS agree on Home, the site overview and /api/v1/asa', async () => {
    const h = await homeOf();
    const y = h.sinceYesterday.asa;
    const o = (await w.admin(`/api/sites/${app.id}/asa?period=30d`)).body;
    const key = (await w.admin(`/api/sites/${app.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: true } })).body.token;
    const res = await w.fetch('/api/v1/asa?period=30d', { headers: { cookie: '', authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const v1 = (await res.json()) as any;

    // One window: the 30 days up to yesterday in New York, on every surface.
    const today = dayInTz(Date.now(), 'America/New_York');
    const back = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) - d * DAY).toISOString().slice(0, 10);
    for (const r of [o, v1]) expect([r.from, r.to]).toEqual([back(30), back(1)]);
    expect([y.from, y.to]).toEqual([back(30), back(1)]);
    expect(y.day).toBe(back(1));

    // Spend: the fixture's 30 days, to the cent. A window one day off either way adds today's or loses day 30's spend.
    let expected = 0;
    for (let d = 1; d <= 30; d++) expected += spendOn(d) / 10_000;
    expect(o.totals.spend).toBe(expected);
    expect(v1.totals.spend).toBe(expected);
    expect(y.periodSpend.USD).toBe(expected);
    expect(y.spend.USD).toBe(spendOn(1) / 10_000);

    // Paid users, cost per paid and ROAS.
    expect(o.totals.paid).toBe(15);
    expect(v1.totals.paid).toBe(o.totals.paid);
    expect(y.paid).toBe(o.totals.paid);
    expect(y.costPerPaid.USD).toBe(Math.round(o.totals.cpa));
    expect(Math.round(v1.totals.cpa)).toBe(y.costPerPaid.USD);
    expect(y.revenue.USD).toBe(o.totals.revenue);
    expect(y.roas.USD).toBeCloseTo(o.totals.roas, 12);
    expect(v1.totals.roas).toBeCloseTo(o.totals.roas, 12);
  });

  itPro("splits Home's MRR change into new, expansion and churned", async () => {
    const now = Date.now();
    const sub = (id: string, f: Record<string, unknown>) => {
      const row: Record<string, unknown> = { site_id: shop.id, id, provider: 'stripe', status: 'active', started_at: now - 60 * DAY, updated_at: now, sandbox: 0, ...f };
      const cols = Object.keys(row);
      return w.db.prepare(`INSERT INTO subscriptions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => row[c]));
    };
    const old = now - 60 * DAY;
    await w.db.batch([
      sub('mv-steady', { paid_at: old, first_mrr: 1000, mrr: 1000 }),
      sub('mv-new', { paid_at: now - 10 * DAY, first_mrr: 2000, mrr: 2000 }),
      sub('mv-up', { paid_at: old, first_mrr: 1500, mrr: 2500, mrr_changed_at: now - 5 * DAY }),
      sub('mv-gone', { paid_at: old, first_mrr: 800, mrr: 800, ended_at: now - 3 * DAY, status: 'canceled' }),
      sub('mv-down', { paid_at: old, first_mrr: 1200, mrr: 900, mrr_changed_at: now - 4 * DAY }),
    ]);
    const t = (await homeOf()).totals;
    expect(t.mrrStart.USD).toBe(4500);
    expect(t.mrr.USD).toBe(6400);
    // The price cut counts as churned: 800 ended plus 300 less.
    expect(t.mrrMovement).toEqual({ new: { USD: 2000 }, expansion: { USD: 1000 }, churned: { USD: 1100 }, net: { USD: 1900 } });
    const m = t.mrrMovement;
    expect(m.new.USD + m.expansion.USD - m.churned.USD).toBe(t.mrr.USD - t.mrrStart.USD);
  });

  itPro('/api/v1/weekly agrees with the site overview over the same week', async () => {
    const wk = (await w.admin('/api/v1/weekly')).body;
    expect(wk.timezone).toBe('America/New_York');
    // The text a founder pastes into Slack: the week, the timezone and what revenue adds up.
    expect(wk.text.split('\n').slice(0, 2)).toEqual([
      expect.stringMatching(/ \(America\/New_York\), compared with the week before\.$/),
      "Revenue adds payments net of refunds and App Store sales at the customer price, before Apple's cut.",
    ]);
    // The iPhone reads the same text with its bearer token, for its own copy button.
    const login = await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Weekly' }, headers: { cookie: '' } });
    const { token } = (await login.json()) as any;
    const phone = await w.fetch('/api/v1/weekly', { headers: { cookie: '', authorization: `Bearer ${token}` } });
    expect(phone.status).toBe(200);
    expect(((await phone.json()) as any).text).toBe(wk.text);
    expect((await w.fetch('/api/v1/weekly', { headers: { cookie: '', authorization: 'Bearer not-a-token' } })).status).toBe(401);
    for (const site of [shop, app]) {
      const o = await overview(site, `period=custom&from=${wk.first_day}&to=${wk.last_day}`);
      const row = wk.sites.find((s: any) => s.id === site.id);
      expect(row.visitors).toBe(o.current.visitors);
      expect(row.revenue).toBe(o.current.revenue);
    }
  });

  it('counting in another timezone moves the numbers, which is why there is one', async () => {
    const ny = await homeOf();
    const utc = await homeOf('period=30d&tz=UTC');
    expect(utc.tz).toBe('UTC');
    expect(utc.tzSource).toBe('request');
    expect(utc.reportingTz).toBe('America/New_York');
    const row = (h: any) => h.sites.find((s: any) => s.id === shop.id);
    expect(row(utc).current.revenue.USD).not.toBe(row(ny).current.revenue.USD);
  });

  itPro('says what each revenue total adds up', async () => {
    const h = await homeOf();
    const by = (id: string) => h.sites.find((s: any) => s.id === id);
    expect(by(shop.id).basis).toBe('net_of_refunds');
    expect(by(app.id).basis).toBe('mixed');
    expect(h.totals.basis).toBe('mixed');
    const p = (await w.admin('/api/v1/portfolio?period=30d')).body;
    const pf = p.sites.find((s: any) => s.id === app.id);
    expect(pf.basis).toBe('mixed');
    expect(pf.revenue_app_store).toBe(by(app.id).current.appStoreRevenue.USD);
    expect(pf.revenue_app_store).toBeGreaterThan(0);
    expect(pf.revenue_app_store).toBeLessThan(pf.revenue);
    // The site overview says the same as Home and the portfolio.
    expect((await overview(app, 'period=30d')).basis).toBe('mixed');
    expect((await overview(shop, 'period=30d')).basis).toBe('net_of_refunds');
    expect((await overview(app, 'period=30d')).current.appStoreRevenue).toBe(pf.revenue_app_store);
    expect(revenueBasis({ revenue: {}, appStoreRevenue: {} })).toBeNull();
    expect(revenueBasis({ revenue: { USD: 500 }, appStoreRevenue: { USD: 500 } })).toBe('app_store_gross');
  });

  it('a site in another timezone falls back to UTC, the setting picks one, and apply moves every site onto it', async () => {
    const berlin = await w.admin(`/api/sites/${app.id}`, { method: 'PATCH', json: { timezone: 'Europe/Berlin' } });
    expect(berlin.status).toBe(200);
    let s = (await w.admin('/api/settings/reporting-timezone')).body;
    expect(s).toMatchObject({ timezone: 'UTC', source: 'default', differ: [shop.id, app.id] });
    expect((await homeOf()).tz).toBe('UTC');

    const bad = await w.admin('/api/settings/reporting-timezone', { method: 'PUT', json: { timezone: 'Mars/Olympus' } });
    expect(bad.status).toBe(400);
    s = (await w.admin('/api/settings/reporting-timezone', { method: 'PUT', json: { timezone: 'America/New_York' } })).body;
    expect(s).toMatchObject({ timezone: 'America/New_York', source: 'setting', saved: 'America/New_York', differ: [app.id] });
    const h = await homeOf();
    expect(h.tz).toBe('America/New_York');
    expect(h.sites.find((x: any) => x.id === shop.id).current.revenue.USD).toBe((await overview(shop, 'period=30d')).current.revenue);
    expect((await w.admin('/api/v1/weekly')).body.timezone).toBe('America/New_York');

    w.takeRowsWritten();
    const applied = (await w.admin('/api/settings/reporting-timezone/apply', { method: 'POST' })).body;
    expect(applied).toMatchObject({ moved: 1, differ: [] });
    // One row per site moved; the setting was already saved.
    expect(w.takeRowsWritten()).toBe(1);
    const after = await homeOf();
    const o = await overview(app, 'period=30d');
    expect(after.sites.find((x: any) => x.id === app.id).current.revenue.USD).toBe(o.current.revenue);
    expect(after.sites.find((x: any) => x.id === app.id).current.visitors).toBe(o.current.visitors);

    // null goes back to the automatic choice: every site shares New York now.
    s = (await w.admin('/api/settings/reporting-timezone', { method: 'PUT', json: { timezone: null } })).body;
    expect(s).toMatchObject({ timezone: 'America/New_York', source: 'sites', saved: null });
  });

  it('picks the request, then the setting, then the shared timezone, then UTC', () => {
    expect(pickTimezone('Asia/Tokyo', 'Europe/Berlin', ['UTC'])).toEqual({ timezone: 'Asia/Tokyo', source: 'request' });
    expect(pickTimezone('nope', 'Europe/Berlin', ['UTC'])).toEqual({ timezone: 'Europe/Berlin', source: 'setting' });
    expect(pickTimezone(undefined, null, ['Europe/Berlin', 'Europe/Berlin'])).toEqual({ timezone: 'Europe/Berlin', source: 'sites' });
    expect(pickTimezone(undefined, null, ['Europe/Berlin', 'UTC'])).toEqual({ timezone: 'UTC', source: 'default' });
    expect(pickTimezone(undefined, null, [])).toEqual({ timezone: 'UTC', source: 'default' });
  });
});
