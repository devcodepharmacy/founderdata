// GET /api/home for the phone's Pulse grid (docs/MOBILE-API.md section 7): trials in the totals, a chart of the
// comparison period, today against yesterday up to the same time, and parts=pulse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { home, homePulse, sameTimeYesterday } from '../src/worker/home';
import { bucketLabels, bucketOf, offsetsIn, resolveRange } from '../src/worker/lib/time';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 15:00 UTC; every site counts days in UTC.
const NOW = Date.parse('2026-11-04T15:00:00Z');
const TODAY = Date.parse('2026-11-04T00:00:00Z');
const YESTERDAY = TODAY - DAY;

let w: TestWorker;
let shop: any;
let app: any;

const session = (site: any, id: string, ts: number) =>
  w.db
    .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, entry_page, source, channel) VALUES (?, ?, ?, ?, ?, 2, '/', 'Google', 'Organic Search')`)
    .bind(site.id, id, `v-${id}`, ts, ts + 60_000);
const pay = (site: any, id: string, ts: number, amount: number) =>
  w.db
    .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id) VALUES (?, ?, 'stripe', ?, ?, 'payment', 'USD', ?)`)
    .bind(id, site.id, ts, amount, `c-${id}`);
const trial = (site: any, id: string, ts: number, sandbox = 0) =>
  w.db
    .prepare(`INSERT INTO subscriptions (site_id, id, provider, status, trial_start, started_at, sandbox, updated_at) VALUES (?, ?, 'app_store', 'trialing', ?, ?, ?, ?)`)
    .bind(site.id, id, ts, ts, sandbox, ts);

beforeAll(async () => {
  w = await startWorker();
  shop = await w.createSite({ domain: 'pulse-shop.example', currency: 'USD', timezone: 'UTC' });
  app = await w.createSite({ domain: 'pulse-app.invalid', currency: 'USD', timezone: 'UTC', app_bundle_id: 'com.example.pulse' });
  await w.db.batch([
    // Today: 2 visits, a $10 sale at 09:00, a trial at 08:00 (and a sandbox trial that never counts).
    session(shop, 't1', TODAY + 2 * HOUR),
    session(app, 't2', TODAY + 10 * HOUR),
    pay(shop, 'pt1', TODAY + 9 * HOUR, 1000),
    trial(app, 'tr1', TODAY + 8 * HOUR),
    trial(app, 'tr-sb', TODAY + 8 * HOUR, 1),
    // Yesterday before 15:00: a visit, a $5 sale and a trial. After 15:00: a visit, a $100 sale and a trial.
    session(shop, 'y1', YESTERDAY + 5 * HOUR),
    pay(shop, 'py1', YESTERDAY + 6 * HOUR, 500),
    trial(app, 'tr2', YESTERDAY + 3 * HOUR),
    session(shop, 'y2', YESTERDAY + 20 * HOUR),
    pay(shop, 'py2', YESTERDAY + 18 * HOUR, 10_000),
    trial(app, 'tr3', YESTERDAY + 16 * HOUR),
    // Older days, for 7d and 30d.
    ...Array.from({ length: 20 }, (_, i) => session(shop, `o${i}`, TODAY - (i + 2) * DAY + 12 * HOUR)),
    ...Array.from({ length: 20 }, (_, i) => pay(shop, `po${i}`, TODAY - (i + 2) * DAY + 13 * HOUR, 700 + i)),
    ...Array.from({ length: 10 }, (_, i) => trial(app, `tro${i}`, TODAY - (i * 3 + 2) * DAY + 7 * HOUR)),
  ]);
});
afterAll(() => w.dispose());

const sumBy = (points: any[], pick: (p: any) => number) => points.reduce((n, p) => n + pick(p), 0);

describe('home for the Pulse grid', () => {
  it('counts trials started in the period and the one before, sandbox left out', async () => {
    const h = await home(w.db, { period: 'today' }, NOW);
    // Today so far (15 hours) against the 15 hours before: yesterday 09:00 to midnight.
    expect(h.previousRange).toEqual({ from: TODAY - 15 * HOUR, to: TODAY });
    expect(h.compare).toBe('previous');
    expect(h.totals.current.trials).toBe(1);
    expect(h.totals.previous.trials).toBe(1);
    expect(h.sites.find((s) => s.id === app.id)!.current.trials).toBe(1);
    expect(h.sites.find((s) => s.id === shop.id)!.current.trials).toBe(0);
  });

  it('compares today with yesterday up to the same time with compare=sametime', async () => {
    const h = await homePulse(w.db, { period: 'today', compare: 'sametime' }, NOW);
    expect(h.compare).toBe('sametime');
    expect(h.previousRange).toEqual({ from: YESTERDAY, to: NOW - DAY });
    expect(h.totals.current).toMatchObject({ visitors: 2, customers: 1, trials: 1, revenue: { USD: 1000 } });
    // Yesterday before 15:00 only: the visit at 05:00, $5 and the trial at 03:00.
    expect(h.totals.previous).toMatchObject({ visitors: 1, customers: 1, trials: 1, revenue: { USD: 500 } });
    // One point an hour on both charts, 00:00 to 14:00, so point i of one lines up with point i of the other.
    expect(h.series.map((p) => p.bucket)).toEqual(Array.from({ length: 15 }, (_, i) => `2026-11-04T${String(i).padStart(2, '0')}:00`));
    expect(h.previousSeries.map((p) => p.bucket)).toEqual(Array.from({ length: 15 }, (_, i) => `2026-11-03T${String(i).padStart(2, '0')}:00`));
    expect(h.series[9]).toEqual({ bucket: '2026-11-04T09:00', visitors: 0, revenue: { USD: 1000 }, customers: 1, trials: 0 });
    expect(h.series[8].trials).toBe(1);
    expect(h.previousSeries[6]).toMatchObject({ revenue: { USD: 500 }, customers: 1 });
    expect(h.previousSeries[3].trials).toBe(1);
    expect(h.previousSeries[5].visitors).toBe(1);
  });

  it('ignores compare=sametime for any period but today', async () => {
    const a = await homePulse(w.db, { period: '7d', compare: 'sametime' }, NOW);
    const b = await homePulse(w.db, { period: '7d' }, NOW);
    expect(a.compare).toBe('previous');
    expect(a.totals).toEqual(b.totals);
    expect(a.previousRange).toEqual(b.previousRange);
  });

  it('answers only the totals and both charts with parts=pulse, the same numbers as the full answer', async () => {
    for (const q of [{ period: 'today', compare: 'sametime' }, { period: '7d' }, { period: '30d' }]) {
      const full = await home(w.db, q, NOW);
      const pulse = await homePulse(w.db, q, NOW);
      expect(Object.keys(pulse).sort()).toEqual(['compare', 'parts', 'period', 'previousRange', 'range', 'reportingTz', 'series', 'previousSeries', 'totals', 'tz', 'tzSource'].sort());
      expect(pulse.parts).toBe('pulse');
      expect(pulse.totals).toEqual(full.totals);
      expect(pulse.series).toEqual(full.series);
      expect(pulse.previousSeries).toEqual(full.previousSeries);
    }
  });

  it('adds both charts up to the totals: revenue, customers and trials', async () => {
    for (const period of ['today', '7d', '30d']) {
      const h = await home(w.db, { period }, NOW);
      expect(sumBy(h.series, (p) => p.revenue.USD ?? 0)).toBe(h.totals.current.revenue.USD ?? 0);
      expect(sumBy(h.previousSeries, (p) => p.revenue.USD ?? 0)).toBe(h.totals.previous.revenue.USD ?? 0);
      expect(sumBy(h.series, (p) => p.customers)).toBe(h.totals.current.customers);
      expect(sumBy(h.previousSeries, (p) => p.customers)).toBe(h.totals.previous.customers);
      expect(sumBy(h.series, (p) => p.trials)).toBe(h.totals.current.trials);
      expect(sumBy(h.previousSeries, (p) => p.trials)).toBe(h.totals.previous.trials);
    }
    const month = await home(w.db, { period: '30d' }, NOW);
    expect(month.series).toHaveLength(30);
    expect(month.previousSeries).toHaveLength(30);
    expect(month.totals.current.trials).toBe(13);
  });

  it('counts the same trials as Since yesterday over the last 24 hours', async () => {
    const h = await home(w.db, { period: '24h' }, NOW);
    expect(h.totals.current.trials).toBe(h.sinceYesterday!.trials);
    expect(h.totals.previous.trials).toBe(h.sinceYesterday!.trialsPrevious);
  });

  itPro('runs fewer statements for parts=pulse', async () => {
    let statements = 0;
    const counted = new Proxy(w.db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') return (sql: string) => (statements++, target.prepare(sql));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await home(counted, { period: '7d' }, NOW);
    const full = statements;
    statements = 0;
    await homePulse(counted, { period: '7d' }, NOW);
    // Sites, the setting, Apple's report rows read ahead (2), MRR now, its sparkline, the platform tiles (3) and one
    // batch of 5. On the route they leave in two round trips (test/round-trips.test.ts).
    expect(statements).toBe(14);
    expect(statements).toBeLessThan(full - 10);
  });

  it('serves parts=pulse and compare=sametime on the route, to the phone too', async () => {
    const { body } = await w.admin('/api/home?period=today&compare=sametime&parts=pulse');
    expect(body.parts).toBe('pulse');
    expect(body.compare).toBe('sametime');
    expect(body.sites).toBeUndefined();
    expect(body.sinceYesterday).toBeUndefined();
    expect(body.totals.current.trials).toBeGreaterThanOrEqual(0);
    const full = (await w.admin('/api/home?period=7d')).body;
    expect(full.previousSeries).toHaveLength(full.series.length);
    expect(full.series[0]).toEqual(expect.objectContaining({ customers: expect.any(Number), trials: expect.any(Number) }));
  });

  it('keeps today on a 7 day chart the week the clocks went back', () => {
    // New York left daylight saving on 1 November 2026 at 06:00 UTC: 7 days from 29 October run on two offsets.
    const tz = 'America/New_York';
    const now = Date.parse('2026-11-04T15:00:00Z');
    const range = resolveRange({ period: '7d' }, tz, 0, now);
    const o = offsetsIn(tz, range.from, range.to);
    expect(o).toEqual([
      [range.from, -4 * HOUR],
      [Date.parse('2026-11-01T06:00:00Z'), -5 * HOUR],
    ]);
    expect(bucketLabels(range, o)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(bucketOf(Date.parse('2026-10-29T04:30:00Z'), 'day', o)).toBe('2026-10-29');
    expect(bucketOf(Date.parse('2026-11-04T04:30:00Z'), 'day', o)).toBe('2026-11-03');
    expect(bucketOf(Date.parse('2026-11-04T05:30:00Z'), 'day', o)).toBe('2026-11-04');
    // One offset for the whole range: a number, as before.
    expect(offsetsIn('UTC', range.from, range.to)).toBe(0);
  });

  it('keeps yesterday up to the same time inside yesterday', () => {
    expect(sameTimeYesterday(TODAY, 'UTC', NOW)).toEqual({ from: YESTERDAY, to: NOW - DAY });
    // Berlin, the morning after the clocks went back (25 October 2026 had 25 hours): 00:30 local is 23:30 UTC.
    const berlinToday = Date.parse('2026-10-25T23:00:00Z');
    const y = sameTimeYesterday(berlinToday, 'Europe/Berlin', berlinToday + 30 * 60_000);
    expect(y.from).toBe(Date.parse('2026-10-24T22:00:00Z'));
    expect(y.to).toBe(berlinToday + 30 * 60_000 - DAY);
  });
});
