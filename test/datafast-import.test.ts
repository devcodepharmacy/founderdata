// Import from the DataFast API (src/shared/datafast-import.ts, src/worker/imports.ts). DataFast is a fake: tests never call datafa.st.
// Response shapes are copied from DataFast's docs: https://datafa.st/docs/api/website/analytics/timeseries.md
// ({"status":"success","data":[{"visitors":528,"pageviews":604,"sessions":604,"revenue":249,"payments":4,"timestamp":"2026-05-01T00:00:00Z"}]}),
// https://datafa.st/docs/api/website/breakdowns/referrers.md ({"data":[{"referrer":"Google","visitors":1840,"revenue":2890,"payments":33}],
// "pagination":{"limit":20,"offset":0,"total":1}}) and breakdowns/pages.md (hostname, path, visitors, revenue, payments).
// The country, device, browser and OS field names are not in the docs' example responses; the fake uses the field names of the
// docs' `fields=country,visitors,revenue,payments` and `fields=device,...` requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buckets, countryCode, estimateCalls, planRevenue, runDataFastImport, toMinor, type ApiAnswer, type Plan } from '../src/shared/datafast-import';
import { resetShareCachesForTests } from '../src/worker/share';
import { dayInTz } from '../src/worker/lib/time';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';

/** A DataFast stand-in: `visitors` per day, and the same breakdown rows for every window that has traffic. */
function fakeApi(visitors: Record<string, number>, opts: { limit429?: number } = {}) {
  const calls: { path: string; query: Record<string, string> }[] = [];
  let tooMany = opts.limit429 ?? 0;
  const get = async (path: string, query: Record<string, string>): Promise<ApiAnswer> => {
    calls.push({ path, query });
    if (tooMany > 0) {
      tooMany--;
      return { status: 429, retryAfter: 2, body: { status: 'error', error: { code: 'rate_limited', message: 'slow down' } } };
    }
    if (path === 'analytics/timeseries') {
      const data = Object.entries(visitors).map(([d, v]) => ({ visitors: v, pageviews: v * 2, sessions: v, revenue: v === 5 ? 49 : 0, payments: v === 5 ? 1 : 0, timestamp: `${d}T00:00:00Z` }));
      return { status: 200, body: { status: 'success', fields: [], interval: 'day', data, totals: {} } };
    }
    const inWindow = Object.entries(visitors).filter(([d]) => d >= query.startAt && d <= query.endAt);
    const v = inWindow.reduce((n, [, x]) => n + x, 0);
    const one = (row: Record<string, unknown>) => ({ status: 200, body: { status: 'success', data: v ? [row] : [], pagination: { limit: 1000, offset: 0, total: v ? 1 : 0 } } });
    switch (path) {
      case 'analytics/referrers':
        return one({ referrer: 't.co', visitors: v, revenue: v === 5 ? 49 : 0, payments: v === 5 ? 1 : 0 });
      case 'analytics/pages':
        return one({ hostname: 'acme.example', path: '/pricing', visitors: v, revenue: 0, payments: 0 });
      case 'analytics/countries':
        return one({ country: 'Germany', visitors: v, revenue: 0, payments: 0 });
      case 'analytics/devices':
        return one({ device: 'Desktop', visitors: v, revenue: 0, payments: 0 });
      default:
        return one({ [path.endsWith('browsers') ? 'browser' : path.endsWith('campaigns') ? 'utm_campaign' : 'operating_system']: 'X', visitors: v });
    }
  };
  return { get, calls };
}

const plan = (from: string, to: string, granularity: 'day' | 'week' = 'day', use = true): Plan => ({ from, to, granularity, revenue: { unit: 'major', decimals: 2, use } });
const noSleep = async () => undefined;

describe('DataFast import plan', () => {
  it('cuts a range into days or weeks and estimates the calls', () => {
    expect(buckets('2026-01-01', '2026-01-10', 'day')).toHaveLength(10);
    expect(buckets('2026-01-01', '2026-01-10', 'week')).toEqual([
      { day: '2026-01-01', from: '2026-01-01', to: '2026-01-07' },
      { day: '2026-01-08', from: '2026-01-08', to: '2026-01-10' },
    ]);
    // 14 months: day totals 1 call, then 7 breakdowns per bucket. Daily is about 36 minutes, weekly about 7.
    const d = estimateCalls('2025-09-01', '2026-11-08', 'day');
    const w = estimateCalls('2025-09-01', '2026-11-08', 'week');
    expect(d.calls).toBeGreaterThan(2900);
    expect(d.minutes).toBeGreaterThan(48);
    expect(w.calls).toBeLessThan(500);
    expect(w.minutes).toBeLessThan(10);
  });

  it('maps money and country names', () => {
    expect(toMinor(49, 'major', 2)).toBe(4900);
    expect(toMinor(4900, 'minor', 2)).toBe(4900);
    expect(toMinor(500, 'major', 0)).toBe(500);
    expect(countryCode('Germany')).toBe('DE');
    expect(countryCode('United States')).toBe('US');
    expect(countryCode('fr')).toBe('FR');
  });
});

describe('running the import', () => {
  it('reads totals once, skips days with no visitors, pages by 60 a minute and sends rows', async () => {
    const api = fakeApi({ '2026-03-01': 10, '2026-03-02': 0, '2026-03-03': 5 });
    const sent: any[] = [];
    let slept = 0;
    const progress: number[] = [];
    await runDataFastImport(plan('2026-03-01', '2026-03-03'), {
      get: api.get,
      send: async (rows) => void sent.push(...rows),
      sleep: async (ms) => void (slept += ms),
      onProgress: (p) => progress.push(p.done),
    });
    // 1 timeseries, then 7 breakdowns for each of the 2 days with traffic. The empty day costs nothing.
    expect(api.calls).toHaveLength(1 + 2 * 7);
    expect(api.calls.filter((c) => c.path === 'analytics/timeseries')[0].query).toMatchObject({ interval: 'day', startAt: '2026-03-01', endAt: '2026-03-03' });
    // Calls are spaced to stay under 60 a minute.
    expect(slept).toBeGreaterThanOrEqual(13 * 1000);
    expect(progress[progress.length - 1]).toBe(2);
    const by = (kind: string, day: string) => sent.find((r) => r.kind === kind && r.day === day)?.data;
    expect(by('visitors', '2026-03-01')).toEqual({ v: 10, p: 20, s: 10, b: 0, d: 0, n: 1 });
    expect(by('source', '2026-03-01')).toEqual({ X: [10, 0] });
    expect(by('country', '2026-03-03')).toEqual({ DE: [5, 0] });
    expect(by('page', '2026-03-03')).toEqual({ '/pricing': [5, 0] });
    // Revenue: the day total and the source's share, in minor units.
    expect(by('revenue', '2026-03-03')).toEqual({ r: 4900, n: 1 });
    expect(by('source_revenue', '2026-03-03')).toEqual({ X: [4900, 1] });
    expect(sent.some((r) => r.day === '2026-03-02')).toBe(false);
  });

  it('waits on a 429 and tries again, and leaves revenue out when the currency differs', async () => {
    const api = fakeApi({ '2026-03-03': 5 }, { limit429: 1 });
    const sent: any[] = [];
    const sleeps: number[] = [];
    await runDataFastImport(plan('2026-03-03', '2026-03-03', 'day', false), { get: api.get, send: async (r) => void sent.push(...r), sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toContain(2000);
    expect(sent.some((r) => r.kind === 'revenue' || r.kind === 'source_revenue')).toBe(false);
    expect(sent.some((r) => r.kind === 'source')).toBe(true);
  });

  it('refuses a rejected key with a plain message, and resumes by skipping stored buckets', async () => {
    const bad = async (): Promise<ApiAnswer> => ({ status: 401, body: { status: 'error', error: { code: 'unauthorized', message: 'no' } } });
    await expect(runDataFastImport(plan('2026-03-01', '2026-03-02'), { get: bad, send: async () => undefined, sleep: noSleep })).rejects.toThrow('refused the key');
    const api = fakeApi({ '2026-03-01': 10, '2026-03-03': 5 });
    const sent: any[] = [];
    await runDataFastImport(plan('2026-03-01', '2026-03-03'), {
      get: api.get,
      send: async (r) => void sent.push(...r),
      sleep: noSleep,
      done: new Set(['visitors|2026-03-01', 'source|2026-03-01', 'visitors|2026-03-03']),
    });
    expect(api.calls.filter((c) => c.path !== 'analytics/timeseries').every((c) => c.query.startAt === '2026-03-03')).toBe(true);
    expect(sent.some((r) => r.kind === 'visitors')).toBe(false);
    expect(sent.some((r) => r.kind === 'source' && r.day === '2026-03-03')).toBe(true);
  });

  it('pages a breakdown with offset until the total is read', async () => {
    const seen: string[] = [];
    const get = async (path: string, q: Record<string, string>): Promise<ApiAnswer> => {
      if (path === 'analytics/timeseries') return { status: 200, body: { data: [{ visitors: 3, pageviews: 3, sessions: 3, revenue: 0, payments: 0, timestamp: '2026-03-01T00:00:00Z' }] } };
      if (path !== 'analytics/pages') return { status: 200, body: { data: [], pagination: { total: 0 } } };
      seen.push(q.offset);
      const off = Number(q.offset);
      const data = Array.from({ length: off === 0 ? 1000 : 500 }, (_, i) => ({ hostname: 'a', path: `/p${off + i}`, visitors: 1, revenue: 0, payments: 0 }));
      return { status: 200, body: { data, pagination: { limit: 1000, offset: off, total: 1500 } } };
    };
    const sent: any[] = [];
    await runDataFastImport(plan('2026-03-01', '2026-03-01'), { get, send: async (r) => void sent.push(...r), sleep: noSleep });
    expect(seen).toEqual(['0', '1000']);
    expect(Object.keys(sent.find((r) => r.kind === 'page').data)).toHaveLength(1000);
  });
});

describe('imported DataFast history in the stats', () => {
  let w: TestWorker;
  let site: any;
  const day = (o: number) => dayInTz(Date.now() + o * 86_400_000, site.timezone);
  const get = (p: string) => w.admin<any>(`/api/sites/${site.id}/${p}`);
  const filter = (f: Record<string, string>) => `&filters=${encodeURIComponent(JSON.stringify(f))}`;

  async function importWith(from: string, to: string, visitors: Record<string, number>) {
    const id = (await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'datafast', from, to, files: [{ name: 'DataFast API, daily breakdowns' }] } })).body.id;
    const api = fakeApi(visitors);
    await runDataFastImport(plan(from, to), {
      get: api.get,
      send: async (rows) => {
        const r = await w.admin(`/api/sites/${site.id}/imports/${id}/rows`, { method: 'POST', json: { rows } });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      },
      sleep: noSleep,
    });
    return id as string;
  }

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'acme.example' });
    // One native visit today from Google: the first native day is today.
    await w.fetch('/api/event', { method: 'POST', headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.51' }, body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://acme.example/', r: 'https://www.google.com/' }) });
    await w.flush();
  });
  afterAll(() => w.dispose());

  it('answers a source filter over the imported range, with imported revenue kept apart from native revenue', async () => {
    const a = day(-6), b = day(-4);
    const id = await importWith(a, b, { [a]: 10, [day(-5)]: 0, [b]: 5 });
    expect((await w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' })).body.status).toBe('done');
    const q = `period=custom&from=${a}&to=${day(0)}`;
    const all = (await get(`overview?${q}`)).body;
    // Native today (1) plus 15 imported; revenue stays native; imported revenue is a labelled extra.
    expect(all.current.visitors).toBe(16);
    expect(all.current.revenue).toBe(0);
    expect(all.imported).toMatchObject({ from: a, to: b, days: 2, revenue: 4900, payments: 1 });
    // Maya's test: the old range answers a source filter. Imported sources are normalised ("t.co" is X).
    const x = (await get(`overview?${q}${filter({ source: 'X' })}`)).body;
    expect(x.current.visitors).toBe(15);
    expect(x.imported).toMatchObject({ days: 2, revenue: 4900 });
    const chart = new Map<string, any>(x.series.map((s: any) => [s.bucket, s]));
    expect(chart.get(a).visitors).toBe(10);
    expect(chart.get(day(0)).visitors).toBe(0);
    const g = (await get(`overview?${q}${filter({ source: 'Google' })}`)).body;
    expect(g.current.visitors).toBe(1);
    expect(g.imported).toBeNull();
    // The sources panel, unfiltered and filtered, with the imported revenue on the row.
    const rows = (await get(`breakdown?dim=source&${q}`)).body;
    expect(rows.find((r: any) => r.label === 'X')).toMatchObject({ visitors: 15, revenue: 0, importedRevenue: 4900, importedPayments: 1 });
    const only = (await get(`breakdown?dim=source&${q}${filter({ source: 'X' })}`)).body;
    expect(only.map((r: any) => r.label)).toEqual(['X']);
    expect(only[0].visitors).toBe(15);
    // Other panels under a source filter cannot be split by source: native rows only.
    expect((await get(`breakdown?dim=country&${q}${filter({ source: 'X' })}`)).body.some((r: any) => r.label === 'DE')).toBe(false);
    // Day-total rows carry no bounce or duration, so the imported days do not pull those rates down.
    expect(all.current.bounceRate).toBeLessThanOrEqual(1);
  });

  it('keeps native days over imported ones and deletes cleanly', async () => {
    const t = day(0);
    const id = (await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'datafast', from: t, to: t, files: [] } })).body.id;
    await w.admin(`/api/sites/${site.id}/imports/${id}/rows`, { method: 'POST', json: { rows: [{ kind: 'visitors', day: t, data: { v: 999, p: 999, s: 999, n: 1 } }] } });
    await w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' });
    const o = (await get(`overview?period=custom&from=${t}&to=${t}`)).body;
    expect(o.current.visitors).toBe(1);
    expect(o.imported).toBeNull();
    expect((await get(`imports/${id}/progress`)).body.keys).toEqual([`visitors|${t}`]);
    expect((await w.admin(`/api/sites/${site.id}/imports/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('hides imported revenue from a share link, a read key and a scoped key that hide revenue', async () => {
    resetShareCachesForTests();
    const a = day(-12), b = day(-11);
    const id = await importWith(a, b, { [a]: 5, [b]: 5 });
    await w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' });
    const q = `period=custom&from=${a}&to=${day(0)}`;
    // The owner sees imported revenue, so the leak check below means something.
    const own = (await get(`overview?${q}`)).body;
    expect(own.imported.revenue).toBeGreaterThanOrEqual(9800);
    const keys = (obj: unknown, out: string[] = []): string[] => {
      if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) (out.push(k), keys(v, out));
      return out;
    };
    const hidden = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', label: 'No money', show_revenue: false } })).body.token;
    const hiddenKey = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', label: 'No money', show_revenue: false } })).body.token;
    const scoped = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'read only', scopes: ['read'], sites: [site.id] } })).body.key;
    const anon = { cookie: '' };
    const paths = [`/api/share/${hidden}/breakdown?dim=source&${q}`, `/api/share/${hidden}/overview?${q}`];
    const api = (token: string, p: string) => w.fetch(`/api/v1/stats/${p}`, { headers: { cookie: '', authorization: `Bearer ${token}` } });
    const bodies: unknown[] = [];
    for (const p of paths) {
      const res = await w.fetch(p, { headers: anon });
      expect(res.status, p).toBe(200);
      bodies.push(await res.json());
    }
    for (const token of [hiddenKey, scoped]) {
      for (const p of [`breakdown?dim=source&${q}`, `overview?${q}`, `timeseries?${q}`]) {
        const res = await api(token, p);
        expect(res.status, p).toBe(200);
        bodies.push(await res.json());
      }
    }
    for (const body of bodies) {
      const leaked = keys(body).filter((k) => /revenue|payments|customers|importedRevenue/i.test(k) && !/^(conversion|revenue_per)/i.test(k));
      expect(leaked, JSON.stringify(body).slice(0, 200)).toEqual([]);
    }
    // Visitors from the import are still there.
    expect(((bodies[1] as any).current.visitors)).toBeGreaterThanOrEqual(10);
    expect((bodies[1] as any).imported.days).toBeGreaterThanOrEqual(2);
  });

  it('checks what the forwarding route accepts, without calling DataFast', async () => {
    const post = (json: unknown) => w.admin(`/api/sites/${site.id}/imports/datafast/get`, { method: 'POST', json });
    expect((await post({ key: 'nope', path: 'analytics/pages' })).status).toBe(400);
    expect((await post({ key: 'df_0123456789abcdef', path: 'payments' })).status).toBe(400);
    expect((await post({ key: 'df_0123456789abcdef', path: '../x' })).status).toBe(400);
  });
});

describe('weekly buckets and native data', () => {
  it('stops the day before the site\'s first own day, so a week never overlaps native data', async () => {
    // Native tracking starts on a Wednesday; the range asks for the whole week and the one after.
    const vis: Record<string, number> = {};
    for (let d = Date.parse('2026-03-02T00:00:00Z'); d <= Date.parse('2026-03-15T00:00:00Z'); d += 86_400_000) vis[new Date(d).toISOString().slice(0, 10)] = 3;
    const api = fakeApi(vis);
    const sent: any[] = [];
    await runDataFastImport({ ...plan('2026-03-02', '2026-03-15', 'week'), nativeFrom: '2026-03-04' }, { get: api.get, send: async (r) => void sent.push(...r), sleep: noSleep });
    const reads = api.calls.map((c) => c.query.endAt).filter(Boolean);
    expect(reads.every((e) => e <= '2026-03-03')).toBe(true);
    // The one week bucket holds Mon and Tue only: 2 days of 3 visitors.
    expect(sent.find((r) => r.kind === 'source')?.data).toEqual({ X: [6, 0] });
    expect(sent.filter((r) => r.kind === 'visitors').map((r) => r.day)).toEqual(['2026-03-02', '2026-03-03']);
    expect(sent.some((r) => r.day >= '2026-03-04')).toBe(false);
  });
});

describe('revenue guards', () => {
  const site = { currency: 'USD', timezone: 'Europe/Berlin', decimals: 2 };
  it('refuses to import revenue until the unit is chosen, and when the currency is unknown until it is confirmed', () => {
    expect(planRevenue({ data: { currency: 'usd' } }, site, { unit: '', currencyConfirmed: false }).blocked).toContain('Choose how DataFast writes revenue');
    expect(planRevenue({ data: { currency: 'usd' } }, site, { unit: 'major', currencyConfirmed: false })).toMatchObject({ blocked: null, revenue: { use: true, unit: 'major' } });
    // Metadata failed or has no currency: nothing is imported until the person confirms.
    expect(planRevenue(null, site, { unit: 'minor', currencyConfirmed: false }).blocked).toContain('did not say which currency');
    expect(planRevenue({ data: {} }, site, { unit: 'minor', currencyConfirmed: true }).revenue.use).toBe(true);
    // Leaving revenue out always works.
    expect(planRevenue(null, site, { unit: 'none', currencyConfirmed: false })).toMatchObject({ blocked: null, revenue: { use: false } });
    // Another currency: left out, with a note.
    const eur = planRevenue({ data: { currency: 'EUR' } }, site, { unit: 'major', currencyConfirmed: false });
    expect(eur.revenue.use).toBe(false);
    expect(eur.notes.join(' ')).toContain('EUR');
  });
  it('warns when DataFast counts days in another timezone, and the runner refuses a revenue plan without a unit', async () => {
    const r = planRevenue({ data: { currency: 'USD', timezone: 'America/New_York' } }, site, { unit: 'major', currencyConfirmed: false });
    expect(r.notes.join(' ')).toContain('America/New_York');
    expect(planRevenue({ data: { currency: 'USD', timezone: 'Europe/Berlin' } }, site, { unit: 'major', currencyConfirmed: false }).notes).toEqual([]);
    const bad = { ...plan('2026-03-01', '2026-03-01'), revenue: { unit: '' as any, decimals: 2, use: true } };
    await expect(runDataFastImport(bad, { get: fakeApi({}).get, send: async () => undefined, sleep: noSleep })).rejects.toThrow('Choose how DataFast writes revenue');
  });
  it('says what a bad source_revenue row needs', async () => {
    const w = await startWorker();
    try {
      const site2 = await w.createSite({ domain: 'acme2.example' });
      const id = (await w.admin(`/api/sites/${site2.id}/imports`, { method: 'POST', json: { source: 'datafast', from: '2026-03-01', to: '2026-03-01', files: [] } })).body.id;
      const res = await w.admin(`/api/sites/${site2.id}/imports/${id}/rows`, { method: 'POST', json: { rows: [{ kind: 'source_revenue', day: '2026-03-01', data: { X: [1] } }] } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('[minor units, payments]');
    } finally {
      await w.dispose();
    }
  });
});
