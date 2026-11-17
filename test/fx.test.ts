import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convert, convertMajor, convertPayments, rateLookup } from '../src/worker/fx';
import { seriesCalls, startWorker, type TestWorker } from './helpers/worker';

describe('fx: payments in other currencies count in the site currency', () => {
  let w: TestWorker;
  let site: any;
  const DAY = 86_400_000;
  const pay = (id: string, amount: number, currency: string, ts = Date.now()) =>
    w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency) VALUES (?, ?, 'stripe', ?, ?, ?, ?)")
      .bind(id, site.id, ts, amount, amount < 0 ? 'refund' : 'payment', currency)
      .run();
  const conv = async (id: string) =>
    (await w.db.prepare('SELECT amount_conv FROM payments WHERE id = ?').bind(id).first<{ amount_conv: number | null }>())!.amount_conv;

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'fx-shop.com', currency: 'EUR' });
  });
  afterAll(() => w.dispose());

  it('converts between minor units of any two published currencies', () => {
    const rates = new Map([['EUR', 1], ['USD', 1.25], ['JPY', 160]]);
    expect(convert(4900, 'USD', 'EUR', rates)).toBe(3920);
    expect(convert(1600, 'JPY', 'EUR', rates)).toBe(1000);
    expect(convert(1000, 'EUR', 'JPY', rates)).toBe(1600);
    expect(convert(-1250, 'USD', 'EUR', rates)).toBe(-1000);
    expect(convert(100, 'AED', 'EUR', rates)).toBeNull();
  });

  it('adds a USD payment to the EUR revenue, and keeps a currency the ECB does not publish out', async () => {
    await pay('fx_eur', 2900, 'EUR');
    await pay('fx_usd', 4900, 'USD');
    await pay('fx_aed', 10000, 'AED');
    const o = (await w.admin(`/api/sites/${site.id}/overview?period=today`)).body;
    expect(o.currency).toBe('EUR');
    expect(o.current.revenue).toBe(2900 + 3920);
    expect(o.current.payments).toBe(3);
    expect(o.series.reduce((n: number, b: any) => n + b.revenue, 0)).toBe(2900 + 3920);
    expect(await conv('fx_eur')).toBeNull();
    expect(await conv('fx_aed')).toBeNull();
    const rows = (await w.admin(`/api/sites/${site.id}/revenue?period=today`)).body;
    expect(rows.find((r: any) => r.currency === 'USD')).toMatchObject({ net: 4900, netConverted: 3920, counted: true });
    expect(rows.find((r: any) => r.currency === 'AED')).toMatchObject({ net: 10000, netConverted: null, counted: false });
  });

  it('uses the rate of the payment day and stores past days', async () => {
    const ts = Date.now() - 3 * DAY;
    const day = new Date(ts).toISOString().slice(0, 10);
    await pay('fx_old', 1250, 'USD', ts);
    await convertPayments(w.db);
    expect(await conv('fx_old')).toBe(1000);
    const stored = await w.db.prepare('SELECT COUNT(*) AS n FROM fx_rates WHERE day = ?').bind(day).first<{ n: number }>();
    expect(stored!.n).toBe(4); // EUR, USD, JPY, CHF
  });

  it('converts a payment once the rate service answers again', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await pay('fx_later', 2500, 'USD', Date.now() - 10 * DAY);
    try {
      expect(await convertPayments(w.db)).toBe(0);
      expect(await conv('fx_later')).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
    expect(await convertPayments(w.db)).toBe(1);
    expect(await conv('fx_later')).toBe(2000);
  });

  it('converts again into a new site currency', async () => {
    const res = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { currency: 'USD' } });
    expect(res.status).toBe(200);
    expect(await conv('fx_usd')).toBeNull();
    expect(await conv('fx_eur')).toBe(3625); // 29.00 EUR at 1.25
    const o = (await w.admin(`/api/sites/${site.id}/overview?period=today`)).body;
    expect(o.currency).toBe('USD');
    expect(o.current.revenue).toBe(3625 + 4900);
  });
});

describe('fx: rates over a range of days', () => {
  let w: TestWorker;
  const now = Date.parse('2026-10-30T12:00:00Z');
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());

  it('fills a quarter with one time-series call, stores it, and reads it back after', async () => {
    const before = seriesCalls.length;
    const rates = await rateLookup(w.db, ['USD', 'JPY', 'XTS'], '2026-07-01', '2026-09-30', fetch, now);
    expect(seriesCalls.slice(before)).toEqual(['2026-06-24..2026-09-30']);
    expect(rates('USD', '2026-07-01')).toBe(1.25);
    // A Saturday uses Friday's rate; EUR is 1; a currency the ECB does not publish has none.
    expect(rates('JPY', '2026-07-04')).toBe(160);
    expect(rates('EUR', '2026-07-04')).toBe(1);
    expect(rates('XTS', '2026-07-01')).toBeNull();
    expect(convertMajor(160, 'JPY', 'USD', '2026-07-04', rates)).toBe(1.25);
    expect(convertMajor(7, 'XTS', 'EUR', '2026-07-04', rates)).toBeNull();
    expect(convertMajor(7, 'XTS', 'XTS', '2026-07-04', rates)).toBe(7);
    const stored = await w.db.prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE day >= '2026-07-01' AND day <= '2026-09-30' AND currency = 'EUR'").first<{ n: number }>();
    expect(stored!.n).toBe(66); // the weekdays of Q3 2026

    await rateLookup(w.db, ['USD'], '2026-08-01', '2026-08-31', fetch, now);
    expect(seriesCalls.length).toBe(before + 1);
  });

  it('asks again after the rate service failed, and never stores today', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    const down = (async () => (calls++, new Response('down', { status: 503 }))) as typeof fetch;
    const r1 = await rateLookup(w.db, ['USD'], '2026-10-01', '2026-10-30', down, now);
    // Nothing stored for October yet: the nearest older rate (30 Sep) stands in.
    expect(r1('USD', '2026-10-15')).toBe(1.25);
    await rateLookup(w.db, ['USD'], '2026-10-01', '2026-10-30', down, now);
    expect(calls).toBe(2);
    await rateLookup(w.db, ['USD'], '2026-10-01', '2026-10-30', real, now);
    const today = await w.db.prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE day = '2026-10-30'").first<{ n: number }>();
    expect(today!.n).toBe(0);
    const yesterday = await w.db.prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE day = '2026-10-29'").first<{ n: number }>();
    expect(yesterday!.n).toBe(4);
  });
});
