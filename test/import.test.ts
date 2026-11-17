// History imported from a Plausible export (src/shared/plausible-import.ts, src/shared/zip.ts, src/worker/imports.ts).
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, parseCsv, tableOf, validDay } from '../src/shared/plausible-import';
import { readZip } from '../src/shared/zip';
import { dayInTz } from '../src/worker/lib/time';
import { impactOf, type Note } from '../src/worker/notes';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';

const VISITORS = 'date,visitors,pageviews,visits,visit_duration,bounces\n2026-01-01,10,25,12,600,5\n2026-01-02,4,8,4,100,2\nnot-a-day,1,1,1,1,1\n';
const SOURCES = 'date,source,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,pageviews,visitors,visits,visit_duration,bounces\n2026-01-01,Google,,,,,,,10,6,6,0,0\n2026-01-01,Direct / None,,,,,,,5,3,3,0,0\n2026-01-01,Google,,,,,,,2,1,1,0,0\n2026-01-02,Hacker News,,,,launch,,,4,2,2,0,0\n';
const PAGES = 'date,hostname,page,visits,visitors,pageviews,visit_duration,bounces\n2026-01-01,acme.example,"/pricing, new",5,4,9,0,0\n2026-01-01,acme.example,/,5,6,16,0,0\n';
const LOCATIONS = 'date,country,region,city,visitors,visits,pageviews,visit_duration,bounces\n2026-01-01,DE,,,5,5,10,0,0\n2026-01-01,ZZ,,,1,1,1,0,0\n';
const EVENTS = 'date,name,link_url,path,visitors,events\n2026-01-01,Signup,,/,3,4\n2026-01-01,Outbound Link: Click,https://x.example,/,2,2\n';

/** A zip with one stored and one deflated entry, built by hand so the reader is tested against the format, not itself. */
function zip(files: { name: string; text: string; deflate?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.text);
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(f.deflate ? 8 : 0, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    parts.push(local, name, data);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

describe('Plausible CSV parser', () => {
  it('reads quotes, doubled quotes, line breaks in a field, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  });

  it('tells the tables apart by their columns', () => {
    expect(tableOf(['date', 'visitors', 'pageviews', 'visits', 'visit_duration', 'bounces'])).toBe('imported_visitors');
    expect(tableOf(['date', 'source', 'utm_medium'])).toBe('imported_sources');
    expect(tableOf(['date', 'page', 'hostname'])).toBe('imported_pages');
    expect(tableOf(['date', 'name', 'link_url'])).toBe('imported_custom_events');
    expect(tableOf(['date', 'x'])).toBeNull();
    expect(tableOf(['visitors', 'visits'])).toBeNull();
  });

  it('checks days', () => {
    expect(validDay('2026-02-28')).toBe(true);
    expect(validDay('2026-02-30')).toBe(false);
    expect(validDay('26-01-01')).toBe(false);
    expect(validDay(20260101)).toBe(false);
  });

  it('turns the files into one row per kind per day', () => {
    const { rows, preview } = aggregate([
      { name: 'imported_visitors_20260101_20260102.csv', text: VISITORS },
      { name: 'imported_sources_20260101_20260102.csv', text: SOURCES },
      { name: 'imported_pages_20260101_20260102.csv', text: PAGES },
      { name: 'imported_locations_20260101_20260102.csv', text: LOCATIONS },
      { name: 'imported_custom_events_20260101_20260102.csv', text: EVENTS },
      { name: 'imported_custom_props.csv', text: 'date,x\n' },
      { name: 'notes.txt', text: 'hello' },
    ]);
    const get = (kind: string, day: string) => rows.find((r) => r.kind === kind && r.day === day)?.data;
    expect(get('visitors', '2026-01-01')).toEqual({ v: 10, p: 25, s: 12, b: 5, d: 600 });
    // Same source twice on a day is summed; "Direct / None" is stored as the empty label.
    expect(get('source', '2026-01-01')).toEqual({ Google: [7, 12], '': [3, 5] });
    expect(get('campaign', '2026-01-02')).toEqual({ launch: [2, 4] });
    expect(get('page', '2026-01-01')).toEqual({ '/pricing, new': [4, 9], '/': [6, 16] });
    // Unknown countries (ZZ) are dropped.
    expect(get('country', '2026-01-01')).toEqual({ DE: [5, 10] });
    // Outbound link events are not goals.
    expect(get('goal', '2026-01-01')).toEqual({ Signup: [3, 4] });
    expect(preview).toMatchObject({ from: '2026-01-01', to: '2026-01-02', days: 2, totals: { visitors: 14, pageviews: 33 } });
    expect(preview.files.find((f) => f.name === 'imported_visitors_20260101_20260102.csv')).toMatchObject({ rows: 3, skipped: 1 });
    expect(preview.files.find((f) => f.name === 'notes.txt')?.note).toBe('Not a CSV file');
    expect(preview.files.find((f) => f.name === 'imported_custom_props.csv')?.note).toMatch(/not imported/);
  });

  it('keeps the labels with the most visitors when a day has too many', () => {
    const lines = ['date,page,visitors,pageviews'];
    for (let i = 0; i < 1100; i++) lines.push(`2026-01-01,/p${i},${i + 1},1`);
    const { rows, preview } = aggregate([{ name: 'imported_pages.csv', text: lines.join('\n') }]);
    expect(Object.keys(rows[0].data)).toHaveLength(1000);
    expect((rows[0].data as any)['/p1099']).toBeDefined();
    expect((rows[0].data as any)['/p0']).toBeUndefined();
    expect(preview.truncated).toBe(1);
  });

  it('says so when nothing can be read', () => {
    expect(aggregate([{ name: 'a.csv', text: 'foo,bar\n1,2\n' }]).preview.warnings[0]).toMatch(/No rows/);
  });
});

describe('zip reader', () => {
  it('reads stored and deflated entries and skips folders', async () => {
    const entries = readZip(zip([{ name: 'a.csv', text: 'one,two\n' }, { name: 'sub/b.csv', text: 'x'.repeat(5000), deflate: true }]));
    expect(entries.map((e) => e.name)).toEqual(['a.csv', 'sub/b.csv']);
    expect(await entries[0].text()).toBe('one,two\n');
    expect(await entries[1].text()).toBe('x'.repeat(5000));
  });

  it('stops a zip that unpacks past 200 MB and refuses zip64', async () => {
    const bomb = readZip(zip([{ name: 'big.csv', text: 'a'.repeat(201 * 1024 * 1024), deflate: true }]));
    await expect(bomb[0].text()).rejects.toThrow(/200 MB/);
    const ok = zip([{ name: 'a.csv', text: 'one\n', deflate: true }]);
    const flagged = Uint8Array.from(ok);
    const eocd = flagged.length - 22;
    flagged[eocd + 10] = 0xff;
    flagged[eocd + 11] = 0xff;
    expect(() => readZip(flagged)).toThrow(/zip64/);
  });

  it('refuses a file that is not a zip', () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a zip/);
  });
});

describe('imported history in the stats', () => {
  let w: TestWorker;
  let site: any;
  const day = (offset: number) => dayInTz(Date.now() + offset * 86_400_000, site.timezone);
  const get = (path: string) => w.admin<any>(`/api/sites/${site.id}/${path}`);
  const send = async (id: string, rows: unknown[]) => w.admin(`/api/sites/${site.id}/imports/${id}/rows`, { method: 'POST', json: { rows } });

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'imp.example' });
    // One native visit today: the site's first native day is today.
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.40' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://imp.example/native' }),
    });
    await w.flush();
  });
  afterAll(() => w.dispose());

  it('adds imported days before the first native day, and native data wins on a day that has both', async () => {
    const from = day(-5);
    const to = day(0);
    const start = await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'plausible', from, to, files: [] } });
    expect(start.status).toBe(200);
    const id = start.body.id;
    const totals = (d: string, v: number) => ({ kind: 'visitors', day: d, data: { v, p: v * 2, s: v, b: 0, d: v * 10 } });
    const stored = await send(id, [
      totals(day(-5), 10),
      totals(day(-4), 20),
      // Today has native data: this row must not be counted.
      totals(day(0), 500),
      { kind: 'source', day: day(-4), data: { Google: [15, 30], '': [5, 9] } },
      { kind: 'source', day: day(0), data: { Google: [400, 800] } },
      { kind: 'country', day: day(-4), data: { DE: [20, 40] } },
    ]);
    expect(stored.status).toBe(200);

    // Not counted until it is finished.
    expect((await get(`overview?period=custom&from=${day(-5)}&to=${day(0)}`)).body.imported).toBeNull();
    expect((await w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' })).body.status).toBe('done');

    const o = (await get(`overview?period=custom&from=${day(-5)}&to=${day(0)}`)).body;
    expect(o.current.visitors).toBe(1 + 30);
    expect(o.current.pageviews).toBe(1 + 60);
    // native_from is the seam: the first day with the site's own visit (today), and the chart bucket that holds it.
    expect(o.imported).toEqual({ from: day(-5), to: day(-4), days: 2, native_from: day(0), seam_bucket: day(0) });
    const chart = new Map<string, any>(o.series.map((s: any) => [s.bucket, s]));
    expect(chart.get(day(-4)).visitors).toBe(20);
    expect(chart.get(day(-4)).imported).toBe(true);
    expect(chart.get(day(0)).visitors).toBe(1);
    expect(chart.get(day(0)).imported).toBeUndefined();
    // Revenue and customers stay native.
    expect(o.current.revenue).toBe(0);

    const sources = (await get(`breakdown?dim=source&period=custom&from=${day(-5)}&to=${day(0)}`)).body;
    const by = new Map<string | null, any>(sources.map((r: any) => [r.label, r]));
    expect(by.get('Google').visitors).toBe(15);
    expect(by.get(null).visitors).toBeGreaterThanOrEqual(5);
    expect(sources.some((r: any) => r.visitors === 400)).toBe(false);
    expect((await get(`breakdown?dim=country&period=custom&from=${day(-5)}&to=${day(0)}`)).body.find((r: any) => r.label === 'DE').visitors).toBe(20);

    // A range after the imported days, and a filtered view, show native data only.
    expect((await get(`overview?period=custom&from=${day(0)}&to=${day(0)}`)).body.imported).toBeNull();
    // A filter on one dimension is answered from that panel's imported rows (country DE: 20 imported visitors on day -4);
    // two filters at once cannot be, so they show no imported day.
    const de = (await get(`overview?period=custom&from=${day(-5)}&to=${day(0)}&filters=${encodeURIComponent(JSON.stringify({ country: 'DE' }))}`)).body;
    expect(de.imported).toMatchObject({ from: day(-4), to: day(-4), days: 1 });
    expect(de.current.visitors).toBe(20);
    expect((await get(`overview?period=custom&from=${day(-5)}&to=${day(0)}&filters=${encodeURIComponent(JSON.stringify({ country: 'DE', device: 'Desktop' }))}`)).body.imported).toBeNull();
  });

  it('leaves imported days out of a note impact, which sits next to native customers and revenue', async () => {
    // The first test imported 10 and 20 visitors on days -5 and -4. A site-wide note 3 days ago compares 3 days either side.
    const ts = Date.now() - 3 * 86_400_000;
    await w.db.prepare("INSERT INTO notes (id, site_id, ts, text, kind, created_at) VALUES ('note-imp', ?, ?, 'Changed the headline', 'change', ?)").bind(site.id, ts, ts).run();
    const note = await w.db.prepare("SELECT * FROM notes WHERE id = 'note-imp'").first<Note>();
    const impact = await impactOf(w.db, site, note!, 3);
    expect(impact.before.visitors).toBe(0);
    expect(impact.after.visitors).toBe(1);
    // The overview of the same days does count them, so the option is what keeps them out.
    const o = (await get(`overview?period=custom&from=${day(-6)}&to=${day(-3)}`)).body;
    expect(o.current.visitors).toBe(30);
  });

  it('refuses an overlapping import, rows outside the days, and bad rows', async () => {
    const clash = await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'plausible', from: day(-2), to: day(-1), files: [] } });
    expect(clash.status).toBe(409);
    const ok = await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'plausible', from: day(-40), to: day(-30), files: [] } });
    const id = ok.body.id;
    expect((await send(id, [{ kind: 'source', day: day(-1), data: {} }])).status).toBe(400);
    expect((await send(id, [{ kind: 'nope', day: day(-35), data: {} }])).status).toBe(400);
    expect((await send(id, [{ kind: 'page', day: day(-35), data: { '/': [1] } }])).status).toBe(400);
    expect((await send(id, [{ kind: 'visitors', day: day(-35), data: { v: 1 } }])).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}/imports/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('stops at the daily allowance with 429 and lists the import', async () => {
    const w2 = await startWorker({ IMPORT_DAILY_ROWS: '3' });
    try {
      const s = await w2.createSite({ domain: 'imp2.example' });
      const d = (o: number) => dayInTz(Date.now() + o * 86_400_000, s.timezone);
      const id = (await w2.admin(`/api/sites/${s.id}/imports`, { method: 'POST', json: { source: 'plausible', from: d(-9), to: d(-1), files: [] } })).body.id;
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'page', day: d(-9 + i), data: { '/': [1, 1] } }));
      expect((await w2.admin(`/api/sites/${s.id}/imports/${id}/rows`, { method: 'POST', json: { rows: rows(3) } })).status).toBe(200);
      const over = await w2.admin(`/api/sites/${s.id}/imports/${id}/rows`, { method: 'POST', json: { rows: rows(1) } });
      expect(over.status).toBe(429);
      const list = (await w2.admin(`/api/sites/${s.id}/imports`)).body;
      expect(list.imports).toHaveLength(1);
      expect(list.allowance).toMatchObject({ used: 3, limit: 3 });
      expect(list.native_from).toBeNull();
      // An unfinished import says how many day-rows are stored, which is where Resume continues after a reload.
      expect(list.imports[0]).toMatchObject({ status: 'importing', stored: 3 });
    } finally {
      await w2.dispose();
    }
  });

  it('is deleted with the site', async () => {
    await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' });
    const left = await w.db.prepare('SELECT (SELECT COUNT(*) FROM imports WHERE site_id = ?1) + (SELECT COUNT(*) FROM imported_daily WHERE site_id = ?1) AS n').bind(site.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
