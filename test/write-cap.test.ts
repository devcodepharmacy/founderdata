// The daily write cap (src/worker/budget.ts): on by default, drops web events and defers app batches once a site
// wrote its cap of rows today, counts with the cap off too, and starts over each UTC day. Sites on the automatic cap
// share one pool of 80,000 rows, counted in the site_usage row `*`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POOL_ID, POOL_ROWS, resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { utcDay } from '../src/worker/identity';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const BUNDLE = 'com.example.capped';

describe('daily write cap', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());
  beforeEach(() => resetBudgetForTests(10));

  const pageview = (site: any, ip: string) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': ip },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}/` }),
    });
  const appBatch = (site: any) =>
    w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid: crypto.randomUUID(), ctx: { bundle_id: BUNDLE }, events: [{ t: 'session_start', sid: crypto.randomUUID() }] }),
    });
  const settings = async (site: any) => (await w.admin(`/api/sites/${site.id}`)).body;
  const sessions = async (site: any) =>
    (await w.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE site_id = ?').bind(site.id).first<{ n: number }>())!.n;

  const poolRows = async () =>
    (await w.db.prepare('SELECT rows FROM site_usage WHERE site_id = ? AND day = ?').bind(POOL_ID, utcDay(Date.now())).first<{ rows: number }>())?.rows ?? 0;
  const setPool = (rows: number) =>
    w.db.prepare('INSERT OR REPLACE INTO site_usage (site_id, day, rows) VALUES (?, ?, ?)').bind(POOL_ID, utcDay(Date.now()), rows).run();

  it('is on and automatic for a new site: it shares 80% of the free plan with the other automatic sites', async () => {
    const site = await w.createSite();
    const s = await settings(site);
    expect(s.write_cap_on).toBe(1);
    expect(s.write_cap).toBeNull();
    expect(POOL_ROWS).toBe(80_000);
    expect(s.usage).toMatchObject({ rows: 0, cap: 80_000, auto: 80_000, shared: true, capped_at: null });
  });

  it('lets one automatic site use far more than an even split while the pool has room', async () => {
    // 11 sites: an even split would give each 7,272 rows.
    for (let i = 0; i < 10; i++) await w.createSite();
    const busy = await w.createSite();
    const day = utcDay(Date.now());
    await w.db.prepare('INSERT INTO site_usage (site_id, day, rows) VALUES (?, ?, 20000)').bind(busy.id, day).run();
    await setPool(20_000);
    expect((await pageview(busy, '198.51.100.200')).status).toBe(202);
    await w.flush();
    expect(await sessions(busy)).toBe(1);
    const s = await settings(busy);
    expect(s.usage).toMatchObject({ rows: 20_011, shared: true, capped_at: null });
    expect(s.usage.pool_rows).toBe(20_011);
  });

  it('stops one automatic site at half the pool when there are other sites, and leaves the rest to them', async () => {
    const flooded = await w.createSite();
    const other = await w.createSite();
    const day = utcDay(Date.now());
    await w.db.prepare('INSERT INTO site_usage (site_id, day, rows) VALUES (?, ?, ?)').bind(flooded.id, day, POOL_ROWS / 2).run();
    await setPool(POOL_ROWS / 2);
    expect((await pageview(flooded, '198.51.100.201')).status).toBe(202);
    expect((await pageview(other, '198.51.100.202')).status).toBe(202);
    await w.flush();
    expect(await sessions(flooded)).toBe(0);
    expect(await sessions(other)).toBe(1);
    expect((await settings(flooded)).usage).toMatchObject({ shared: true, site_max: POOL_ROWS / 2 });
  });

  it('adds every site to the pool, one extra row per flush, and stops automatic sites when the pool is used up', async () => {
    resetBudgetForTests(10, 1_000);
    await setPool(980);
    const a = await w.createSite();
    const b = await w.createSite();
    const fixed = await w.createSite({ write_cap: 500 });
    const off = await w.createSite({ write_cap_on: 0 });

    // 11 rows for a new visitor; the flush writes the site's row and the pool's row.
    w.takeRowsWritten();
    await pageview(a, '198.51.100.31');
    await w.flush();
    expect(w.takeRowsWritten()).toBe(11 + 2);
    expect(await poolRows()).toBe(991);

    // The pool is not full yet: 991 of 1,000. The fixed site's 11 rows fill it.
    await pageview(fixed, '198.51.100.32');
    await w.flush();
    expect(await poolRows()).toBe(1_002);

    // Both automatic sites are now over; the fixed site and the site with the cap off keep writing.
    await pageview(a, '198.51.100.33');
    await pageview(b, '198.51.100.34');
    await pageview(fixed, '198.51.100.35');
    await pageview(off, '198.51.100.36');
    await w.flush();
    expect(await sessions(a)).toBe(1);
    expect(await sessions(b)).toBe(0);
    expect(await sessions(fixed)).toBe(2);
    expect(await sessions(off)).toBe(1);

    // Every automatic site shows the time the pool ran out, here and on the home page's badges.
    const listed = (await w.admin('/api/sites')).body;
    const at = (id: string) => listed.find((x: any) => x.id === id).capped_at;
    expect(at(a.id)).toBeGreaterThan(0);
    expect(at(b.id)).toBe(at(a.id));
    expect(at(fixed.id)).toBeNull();
    expect(at(off.id)).toBeNull();
    expect((await settings(b)).usage).toMatchObject({ shared: true, cap: 1_000, capped_at: at(a.id) });
    const usage = (await w.admin('/api/usage')).body;
    expect(usage.capped[a.id]).toBe(at(a.id));
    expect(usage.capped[b.id]).toBe(at(a.id));
    expect(usage.capped[fixed.id]).toBeUndefined();

    // A full pool answers app batches with 429 too.
    const app = await w.createSite({ app_bundle_id: BUNDLE });
    expect((await appBatch(app)).status).toBe(429);
  });

  it('marks the pool full when another instance crossed the line', async () => {
    resetBudgetForTests(10, 1_000);
    await w.db
      .prepare('INSERT OR REPLACE INTO site_usage (site_id, day, rows, capped_at) VALUES (?, ?, 1000, ?)')
      .bind(POOL_ID, utcDay(Date.now()), 1234)
      .run();
    const site = await w.createSite();
    await pageview(site, '198.51.100.40');
    await w.flush();
    expect(await sessions(site)).toBe(0);
    expect((await settings(site)).usage.capped_at).toBe(1234);
  });

  it('drops web events past the cap, marks the time and tells the dashboard', async () => {
    const site = await w.createSite({ write_cap: 30 });
    for (let i = 0; i < 3; i++) expect((await pageview(site, `198.51.100.${i + 1}`)).status).toBe(202);
    await w.flush();
    // 3 new visitors at 11 rows each: past 30, so the next one is dropped and writes nothing.
    expect(await sessions(site)).toBe(3);
    w.takeRowsWritten();
    expect((await pageview(site, '198.51.100.9')).status).toBe(202);
    await w.flush();
    expect(w.takeRowsWritten()).toBe(0);
    expect(await sessions(site)).toBe(3);

    const s = await settings(site);
    expect(s.usage.rows).toBe(33);
    expect(s.usage.cap).toBe(30);
    expect(s.usage.capped_at).toBeGreaterThan(0);
    const listed = (await w.admin('/api/sites')).body.find((x: any) => x.id === site.id);
    expect(listed.capped_at).toBe(s.usage.capped_at);
  });

  it('answers a capped app batch with 429 and Retry-After, so the SDK keeps it for after the reset', async () => {
    const site = await w.createSite({ app_bundle_id: BUNDLE, write_cap: 5 });
    expect((await appBatch(site)).status).toBe(202);
    await w.flush();
    const res = await appBatch(site);
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400);
    expect(await sessions(site)).toBe(1);
  });

  it('keeps writing with the cap off, still counting, and stops again when it is turned back on', async () => {
    const site = await w.createSite({ write_cap: 20, write_cap_on: 0 });
    for (let i = 0; i < 4; i++) await pageview(site, `203.0.113.${i + 1}`);
    await w.flush();
    expect(await sessions(site)).toBe(4);
    const off = await settings(site);
    expect(off.usage).toMatchObject({ rows: 44, cap: null });
    expect((await w.admin('/api/sites')).body.find((x: any) => x.id === site.id).capped_at).toBeNull();

    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { write_cap_on: 1 } });
    forgetSite(site.id);
    await pageview(site, '203.0.113.50');
    await w.flush();
    expect(await sessions(site)).toBe(4);
  });

  it('lets a higher cap take events again the same day, and empty means automatic', async () => {
    const site = await w.createSite({ write_cap: 11 });
    await pageview(site, '192.0.2.1');
    await w.flush();
    await pageview(site, '192.0.2.2');
    await w.flush();
    expect(await sessions(site)).toBe(1);

    const raised = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { write_cap: 1000 } });
    expect(raised.body.usage.cap).toBe(1000);
    forgetSite(site.id);
    await pageview(site, '192.0.2.3');
    await w.flush();
    expect(await sessions(site)).toBe(2);

    const auto = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { write_cap: null } });
    expect(auto.body.write_cap).toBeNull();
    expect(auto.body.usage.cap).toBe(auto.body.usage.auto);
    expect(auto.body.usage.shared).toBe(true);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { write_cap: -5 } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { write_cap: 1.5 } })).status).toBe(400);
  });

  it("ignores yesterday's count", async () => {
    const site = await w.createSite({ write_cap: 30 });
    const yesterday = utcDay(Date.now() - 86_400_000);
    await w.db
      .prepare('INSERT INTO site_usage (site_id, day, rows, capped_at) VALUES (?, ?, 5000, ?)')
      .bind(site.id, yesterday, Date.now() - 86_400_000)
      .run();
    await pageview(site, '192.0.2.77');
    await w.flush();
    expect(await sessions(site)).toBe(1);
    const s = await settings(site);
    expect(s.usage.rows).toBe(11);
    expect(s.usage.capped_at).toBeNull();
  });

  it('picks up the count other Worker instances stored', async () => {
    const site = await w.createSite({ write_cap: 100 });
    await w.db.prepare('INSERT INTO site_usage (site_id, day, rows) VALUES (?, ?, 100)').bind(site.id, utcDay(Date.now())).run();
    await pageview(site, '192.0.2.88');
    await w.flush();
    expect(await sessions(site)).toBe(0);
  });

  it('never caps payment webhooks', async () => {
    const site = await w.createSite({ write_cap: 1 });
    await w.db.prepare('INSERT INTO site_usage (site_id, day, rows) VALUES (?, ?, 50)').bind(site.id, utcDay(Date.now())).run();
    const res = await w.fetch('/api/v1/payments', {
      method: 'POST',
      headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transaction_id: 'txn_cap_1', amount: 9.99, currency: 'USD' }),
    });
    expect(res.status).toBeLessThan(300);
    const n = (await w.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE site_id = ?').bind(site.id).first<{ n: number }>())!.n;
    expect(n).toBe(1);
  });

  it('removes the count with the site', async () => {
    const site = await w.createSite({ write_cap: 30 });
    await pageview(site, '192.0.2.99');
    await w.flush();
    await w.db.prepare('INSERT OR REPLACE INTO site_usage (site_id, day, rows) VALUES (?, ?, 11)').bind(site.id, utcDay(Date.now())).run();
    await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' });
    expect(await w.db.prepare('SELECT 1 FROM site_usage WHERE site_id = ?').bind(site.id).first()).toBeNull();
  });
});
