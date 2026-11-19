// The agent loop (docs/MCP.md "The review loop", docs/API.md "The verdict"): an agent logs a change, waits, lists the
// changes whose window closed with a verdict inline, and marks each reviewed. Impact is scoped to the page a note
// targets, and GET /api/v1/content/page shows one page with its notes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IMPACT_MIN_CUSTOMERS, IMPACT_MIN_LIFT, IMPACT_MIN_VISITORS, judge, targetPath } from '../src/worker/notes';
import { resetShareCachesForTests } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const DAY = 86_400_000;

describe('agent loop: page-scoped impact, verdict, due list and review', () => {
  let w: TestWorker;
  let site: any;
  let other: any;
  let key: string;
  let hidden: string;
  const now = Date.now();
  /** The notes the loop reviews: 10 days ago, so their 7 days after are over. */
  const T = now - 10 * DAY;
  const ids: Record<string, string> = {};

  const bearer = (k: string): Record<string, string> => ({ cookie: '', authorization: `Bearer ${k}` });
  const get = (path: string, k = key) => w.fetch(path, { headers: bearer(k) });
  const json = async (path: string, k = key) => {
    const res = await get(path, k);
    expect(res.status, `${path}: ${res.status} ${res.status === 200 ? '' : await res.clone().text()}`).toBe(200);
    return res.json<any>();
  };
  const postNote = async (body: Record<string, unknown>, apiKey = site.api_key) =>
    (await w.fetch('/api/v1/notes', { method: 'POST', json: body, headers: bearer(apiKey) })).json<any>();
  const review = (id: string, body: unknown, apiKey: string = site.api_key) =>
    w.fetch(`/api/v1/notes/${id}/review`, { method: 'POST', json: body, headers: bearer(apiKey) });

  /** `n` visitors entering on `page`, one session each, a minute apart from `from` + 1 h; the first `buyers` pay `amount`. */
  async function seed(s: any, prefix: string, page: string, from: number, n: number, buyers: number, amount: number) {
    await w.db
      .prepare(
        `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 - 1)
         INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, hostname, source, channel, entry_page)
         SELECT ?2, ?3 || '-s' || i, ?3 || '-v' || i, ?4 + 3600000 + i * 60000, ?4 + 3600000 + i * 60000, 0, 1, 0, ?5, 'Google', 'Organic Search', ?6 FROM k`,
      )
      .bind(n, s.id, prefix, from, s.domain, page)
      .run();
    if (!buyers) return;
    await w.db
      .prepare(
        `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 - 1)
         INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, matched_by)
         SELECT ?2 || '-p' || i, ?3, 'stripe', ?4 + 3600000 + i * 60000 + 1000, ?5, 'payment', 'USD', ?2 || '-v' || i, ?2 || '-s' || i, 'metadata' FROM k`,
      )
      .bind(buyers, prefix, s.id, from, amount)
      .run();
  }

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shipkit.example.com' });
    other = await w.createSite({ domain: 'other.example.com' });
    // /pricing: 200 visitors and 10 buyers on each side; $10 each before, $15 after. Revenue per visitor 50 -> 75.
    await seed(site, 'pb', '/pricing', T - 7 * DAY, 200, 10, 1000);
    await seed(site, 'pa', '/pricing', T, 200, 10, 1500);
    // The home page: 500 visitors before, a 2,000-visitor spike after, nobody buys. Site-wide, revenue per visitor falls.
    await seed(site, 'hb', '/', T - 7 * DAY, 500, 0, 0);
    await seed(site, 'ha', '/', T + DAY, 2000, 0, 0);
    // /blog/x: visits 3 days ago, after every window above, for the page detail.
    await seed(site, 'bx', '/blog/x', now - 3 * DAY, 30, 2, 2000);
    key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
    hidden = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: false } })).body.token;

    ids.pricing = (await postNote({ text: 'Raised Pro to $24', timestamp: T, kind: 'pricing', actor: 'pricing-agent', target: '/pricing?ref=x', before: '$19', after: '$24' })).id;
    ids.site = (await postNote({ text: 'New site-wide banner', timestamp: T + 1000, kind: 'copy', actor: 'site-agent' })).id;
    ids.blog = (await postNote({ text: 'Refreshed the post', timestamp: now - 8 * DAY, kind: 'seo', actor: 'seo-agent', target: '/blog/x' })).id;
    ids.recent = (await postNote({ text: 'Tried a new headline', timestamp: now - 2 * DAY, kind: 'copy', actor: 'pricing-agent', target: '/pricing' })).id;
    ids.otherPage = (await postNote({ text: 'Changed the docs', timestamp: T + DAY, kind: 'copy', target: '/docs' })).id;
  });
  afterAll(() => w?.dispose());
  beforeEach(() => resetShareCachesForTests());

  describe('target scope', () => {
    it('reads a path target as a page, anything else as the site', () => {
      expect(targetPath('/pricing')).toBe('/pricing');
      expect(targetPath(' /pricing?plan=pro#top ')).toBe('/pricing');
      expect(targetPath('/')).toBe('/');
      for (const t of [null, '', 'keyword:habit tracker', 'https://shipkit.example.com/pricing', '//evil.example', 'prod_123']) expect(targetPath(t), String(t)).toBeNull();
    });

    it('counts only visits that entered on the target page, and judges them', async () => {
      const i = await json(`/api/v1/notes/${ids.pricing}/impact`);
      expect(i).toMatchObject({ scope: 'page', page: '/pricing', complete: true, enough_data: true, verdict: 'better', verdict_metric: 'revenue_per_visitor' });
      expect(i.before).toMatchObject({ visitors: 200, customers: 10, revenue: 10000, revenue_per_visitor: 50 });
      expect(i.after).toMatchObject({ visitors: 200, customers: 10, revenue: 15000, revenue_per_visitor: 75 });
      expect(i.reason).toBe('Revenue per visitor rose 50%, from $0.50 to $0.75, on 200 visitors before and 200 after.');
      expect(i.review_after).toBe(new Date(T + 7 * DAY).toISOString());
      expect(i.note.review_after).toBe(i.review_after);
      expect(i.thresholds).toEqual({ min_visitors: IMPACT_MIN_VISITORS, min_customers: IMPACT_MIN_CUSTOMERS, min_lift: IMPACT_MIN_LIFT });
      // The site-wide note at the same time is in the overlap; the note on /docs is about another page.
      expect(i.overlapping.map((n: any) => n.id)).toEqual([ids.site]);
    });

    it('keeps the whole site for a note without a page, where the spike drags revenue per visitor down', async () => {
      const i = await json(`/api/v1/notes/${ids.site}/impact`);
      expect(i).toMatchObject({ scope: 'site', page: null, verdict: 'worse', verdict_metric: 'revenue_per_visitor' });
      expect(i.before.visitors).toBe(700);
      expect(i.after.visitors).toBe(2200);
      expect(i.reason).toMatch(/^Revenue per visitor fell 52%, from \$0\.14 to \$0\.07, on 700 visitors before and 2,200 after\.$/);
      // Overlaps cover the days before the change too: the pricing change a second earlier is in the before numbers.
      expect(i.overlapping.map((n: any) => n.id)).toEqual([ids.pricing, ids.otherPage, ids.blog]);
    });

    it('has no verdict while the window runs, and says when it closes', async () => {
      const i = await json(`/api/v1/notes/${ids.recent}/impact`);
      expect(i).toMatchObject({ complete: false, verdict: 'inconclusive', verdict_metric: null });
      expect(i.reason).toBe(`Measuring, day 2 of 7. The window closes at ${new Date(now - 2 * DAY + 7 * DAY).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    });

    it('judges visitors for a key without revenue, and says nothing about money', async () => {
      const i = await json(`/api/v1/notes/${ids.site}/impact`, hidden);
      expect(i).toMatchObject({ scope: 'site', verdict: 'better', verdict_metric: 'visitors', enough_data: true });
      expect(i.reason).toBe('Visitors rose 214%, from 700 to 2,200.');
      expect(JSON.stringify(i)).not.toMatch(/revenue|customers|conversion/);
    });
  });

  describe('the verdict rule', () => {
    const closed = { complete: true, reviewAfter: '2026-11-09T09:30:00.000Z', currency: 'USD' };
    const side = (visitors: number, customers: number, revenue: number) => ({ visitors, customers, revenue });

    it('needs 100 visitors a side and 10 new customers across both', () => {
      expect(judge(side(99, 20, 5000), side(500, 20, 9000), closed)).toMatchObject({ verdict: 'inconclusive', verdict_metric: null, reason: '99 visitors before and 500 after, but each side needs 100 for a verdict.' });
      expect(judge(side(300, 5, 5000), side(300, 4, 9000), closed)).toMatchObject({ verdict: 'inconclusive', reason: '5 new customers before and 4 after, but both sides together need 10 for a verdict.' });
      // 10 customers to none is enough to call it worse.
      expect(judge(side(300, 10, 5000), side(300, 0, 0), closed)).toMatchObject({ verdict: 'worse', verdict_metric: 'revenue_per_visitor' });
    });

    it('takes a change of 10% or more, and less is inconclusive', () => {
      expect(judge(side(1000, 20, 10000), side(1000, 20, 11000), closed).verdict).toBe('better');
      expect(judge(side(1000, 20, 10000), side(1000, 20, 9000), closed).verdict).toBe('worse');
      const small = judge(side(1000, 20, 10000), side(1000, 20, 10900), closed);
      expect(small).toMatchObject({ verdict: 'inconclusive', verdict_metric: 'revenue_per_visitor' });
      expect(small.reason).toBe('Revenue per visitor moved 9%, from $0.10 to $0.11, less than the 10% a verdict needs.');
    });

    it('falls back to conversion without revenue, and counts from zero as better', () => {
      const conv = judge(side(1000, 5, 0), side(1000, 15, 0), closed);
      expect(conv).toMatchObject({ verdict: 'better', verdict_metric: 'conversion_rate' });
      expect(conv.reason).toBe('Conversion rose 200%, from 0.5% to 1.5%, on 1,000 visitors before and 1,000 after.');
      // 5 to 10 customers doubles the rate, but 10 against 5 is within the noise of counts that small.
      expect(judge(side(1000, 5, 0), side(1000, 10, 0), closed)).toMatchObject({
        verdict: 'inconclusive',
        reason: 'Conversion rose 100%, from 0.5% to 1.0%, on 1,000 visitors before and 1,000 after. That is within normal ups and downs for numbers this small.',
      });
      const fromZero = judge(side(1000, 0, 0), side(1000, 12, 6000), closed);
      expect(fromZero).toMatchObject({ verdict: 'better', verdict_metric: 'revenue_per_visitor' });
      expect(fromZero.reason).toBe('Revenue per visitor rose from $0.00 to $0.06, on 1,000 visitors before and 1,000 after.');
    });
  });

  describe('due list and review', () => {
    it('lists closed, unreviewed notes with the verdict inline, and filters by actor', async () => {
      w.takeRowsWritten();
      const due = await json('/api/v1/notes?due=true');
      expect(w.takeRowsWritten()).toBe(0);
      // Oldest first; the recent note's window is still open, and the SEO note waits for its 28 days.
      expect(due.map((n: any) => n.id)).toEqual([ids.pricing, ids.site, ids.otherPage]);
      // A window passed in applies to every note; the SEO note still waits 4 more days for Search Console.
      expect((await json('/api/v1/notes?due=true&window=3')).map((n: any) => n.id)).toEqual([ids.pricing, ids.site, ids.otherPage, ids.blog]);
      expect(due[0]).toMatchObject({ id: ids.pricing, actor: 'pricing-agent', review: null, review_after: new Date(T + 7 * DAY).toISOString() });
      expect(due[0].impact).toMatchObject({ scope: 'page', verdict: 'better', currency: 'USD', before: { visitors: 200 } });
      expect(due[0].impact).not.toHaveProperty('note');
      const mine = await json('/api/v1/notes?due=true&actor=pricing-agent');
      expect(mine.map((n: any) => n.id)).toEqual([ids.pricing]);
      expect((await json('/api/v1/notes?due=true&limit=1')).length).toBe(1);
      expect((await json('/api/v1/notes?due=true&window=14')).map((n: any) => n.id)).toEqual([]);
      for (const bad of ['limit=0', 'limit=21', 'window=29', 'kind=vibes']) expect((await get(`/api/v1/notes?due=true&${bad}`)).status, bad).toBe(400);
      // Without due, the list is the range's notes as before.
      expect((await json('/api/v1/notes?period=30d&actor=pricing-agent')).length).toBe(2);
    });

    it('gives a key without revenue the visitors verdict', async () => {
      const due = await json('/api/v1/notes?due=true&actor=site-agent', hidden);
      expect(due[0].impact).toMatchObject({ verdict_metric: 'visitors', verdict: 'better' });
      expect(JSON.stringify(due)).not.toMatch(/revenue|customers|conversion|currency/);
    });

    it('marks a note reviewed once, for 1 row, and takes it off the due list at once', async () => {
      // Fill the cache first: the review must still take the note off.
      expect((await json('/api/v1/notes?due=true&actor=pricing-agent')).length).toBe(1);
      w.takeRowsWritten();
      const res = await review(ids.pricing, { outcome: 'kept', comment: '  Revenue per visitor   up 50%. ' });
      expect(res.status).toBe(200);
      expect(w.takeRowsWritten()).toBe(1);
      const body = await res.json<any>();
      expect(body).toMatchObject({ ok: true, id: ids.pricing, reviewed_now: true, note: { review: { outcome: 'kept', comment: 'Revenue per visitor up 50%.' } } });
      expect(Date.parse(body.note.review.reviewed_at)).toBeGreaterThan(now - 60_000);
      expect(await json('/api/v1/notes?due=true&actor=pricing-agent')).toEqual([]);

      const again = await review(ids.pricing, { outcome: 'reverted' });
      expect(again.status).toBe(200);
      expect(await again.json<any>()).toMatchObject({ reviewed_now: false, note: { review: { outcome: 'kept' } } });
      expect(w.takeRowsWritten()).toBe(0);
      // The note itself and its impact show the review.
      expect((await json(`/api/v1/notes/${ids.pricing}/impact`)).note.review.outcome).toBe('kept');
    });

    it('checks the key, the outcome, the comment and the note', async () => {
      expect((await review(ids.site, { outcome: 'kept' }, key)).status).toBe(401);
      expect((await review(ids.site, { outcome: 'kept' }, 'rt_nope')).status).toBe(401);
      expect((await review(ids.site, { outcome: 'maybe' })).status).toBe(400);
      expect((await review(ids.site, {})).status).toBe(400);
      expect((await review(ids.site, { outcome: 'kept', comment: 'x'.repeat(281) })).status).toBe(400);
      expect((await review(ids.site, { outcome: 'kept', comment: 7 })).status).toBe(400);
      expect((await review('nope', { outcome: 'kept' })).status).toBe(404);
      // Another site's key can't review this site's note.
      expect((await review(ids.site, { outcome: 'kept' }, other.api_key)).status).toBe(404);
      expect((await w.db.prepare('SELECT reviewed_at FROM notes WHERE id = ?').bind(ids.site).first<any>()).reviewed_at).toBeNull();
    });
  });

  describe('GET /api/v1/content/page', () => {
    beforeAll(async () => {
      const day = (d: number) => new Date(now - d * DAY).toISOString().slice(0, 10);
      await w.admin(`/api/sites/${site.id}/seo/meta`, { method: 'PUT', json: { version: 1, gscThrough: day(1) } });
      await w.admin(`/api/sites/${site.id}/seo/gsc_pages`, {
        method: 'PUT',
        json: [
          [day(3), 'https://shipkit.example.com/blog/x', 10, 200, 4],
          [day(3), 'https://shipkit.example.com/blog/x?utm=1', 2, 100, 7],
          [day(4), 'https://shipkit.example.com/other/blog/x', 50, 500, 1],
          [day(200), 'https://shipkit.example.com/blog/x', 99, 999, 1],
        ],
      });
    });

    itPro('answers visits and revenue per week, Google numbers and the notes on the page', async () => {
      const p = await json('/api/v1/content/page?path=/blog/x&weeks=4');
      expect(p).toMatchObject({ site_id: site.id, path: '/blog/x', weeks: 4, visitors: 30, customers: 2, revenue: 4000, revenue_per_visitor: 133, currency: 'USD' });
      expect(p.weekly).toHaveLength(4);
      expect(p.weekly.reduce((n: number, x: any) => n + x.visitors, 0)).toBe(30);
      expect(new Date(p.weekly[0].week + 'T00:00:00Z').getUTCDay()).toBe(1);
      expect(p.search).toMatchObject({ clicks: 12, impressions: 300, position: 5, queries: null });
      expect(p.search.weekly).toHaveLength(4);
      expect(p.notes.map((n: any) => n.id)).toEqual([ids.blog]);
      // An SEO note is judged on the page's Search Console clicks over 28 days, so it is still measuring.
      expect(p.notes[0].impact).toMatchObject({ metric: 'search_clicks', scope: 'page', page: '/blog/x', verdict: 'inconclusive', complete: false, reason: expect.stringMatching(/^Measuring, day 7 of 28\. /) });
    });

    itPro('leaves money out for a key without revenue, and checks its parameters', async () => {
      const p = await json('/api/v1/content/page?path=/blog/x', hidden);
      expect(p.weeks).toBe(12);
      expect(JSON.stringify(p)).not.toMatch(/revenue|customers|conversion|currency/);
      expect(p.visitors).toBe(30);
      for (const bad of ['path=blog/x', 'path=', 'path=https://shipkit.example.com/blog/x', 'path=/blog/x&weeks=0', 'path=/blog/x&weeks=27']) {
        expect((await get(`/api/v1/content/page?${bad}`)).status, bad).toBe(400);
      }
      // A page without visits or snapshot rows answers zeros.
      const empty = await json('/api/v1/content/page?path=/nothing');
      expect(empty).toMatchObject({ visitors: 0, notes: [], search: { clicks: 0, position: null } });
    });

    it('answers search null for a site without Search Console pages, and the dashboard reads the same route', async () => {
      const k = (await w.admin(`/api/sites/${other.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
      expect((await json('/api/v1/content/page?path=/', k)).search).toBeNull();
      const dash = await w.admin(`/api/sites/${site.id}/content/page?path=/blog/x&weeks=4`);
      expect(dash.status).toBe(200);
      expect(dash.body.visitors).toBe(30);
    });

    itPro('answers no queries without the gsc_page_queries part, then the page\'s queries once it is pushed', async () => {
      // The dashboard's twin is not cached, so it sees each push at once.
      const page = async () => (await w.admin(`/api/sites/${site.id}/content/page?path=/blog/x&weeks=4`)).body;
      expect((await page()).search.queries).toBeNull();
      await w.admin(`/api/sites/${site.id}/seo/gsc_page_queries`, {
        method: 'PUT',
        json: {
          from: '2026-10-06', to: '2026-11-02', previousFrom: '2026-09-08', previousTo: '2026-10-05',
          rows: [
            ['/blog/x', 'stripe vs paddle', 8, 200, 6.5, 12, 150, 4.5],
            ['https://shipkit.example.com/blog/x?ref=1', 'stripe vs paddle', 2, 50, 8.5, 0, 0, null],
            ['/blog/x', 'paddle fees', 0, 0, null, 3, 40, 6],
            ['/other/blog/x', 'not this page', 50, 500, 1, 0, 0, null],
          ],
        },
      });
      const want = {
        from: '2026-10-06', to: '2026-11-02', previous_from: '2026-09-08', previous_to: '2026-10-05', total: 2,
        rows: [
          { query: 'stripe vs paddle', clicks: 10, impressions: 250, position: 6.9, previous_clicks: 12, previous_impressions: 150, previous_position: 4.5, position_change: -2.4 },
          { query: 'paddle fees', clicks: 0, impressions: 0, position: null, previous_clicks: 3, previous_impressions: 40, previous_position: 6, position_change: null },
        ],
      };
      expect((await page()).search.queries).toEqual(want);
      expect((await json('/api/v1/content/page?path=/blog/x&weeks=3')).search.queries).toEqual(want);
      // A malformed part answers no queries instead of an error.
      await w.admin(`/api/sites/${site.id}/seo/gsc_page_queries`, { method: 'PUT', json: { rows: 'nope' } });
      expect((await page()).search).toMatchObject({ clicks: 12, queries: null });
    });
  });

  describe('over MCP', () => {
    let n = 0;
    const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const res = await w.fetch('/mcp', {
        method: 'POST',
        headers: { cookie: '', 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      return (await res.json<any>()).result;
    };

    itPro('runs the loop: list due changes, review one, and it is gone', async () => {
      const due = await call('list_notes', { due: true, actor: 'site-agent' });
      expect(due.isError).toBeUndefined();
      expect(due.structuredContent.rows.map((r: any) => r.id)).toEqual([ids.site]);
      expect(due.structuredContent.rows[0].impact.verdict).toBe('worse');

      const noKey = await call('review_change', { id: ids.site, outcome: 'reverted' });
      expect(noKey.isError).toBe(true);
      expect(noKey.content[0].text).toMatch(/review_change needs a key with the notes:write scope/);
      const bad = await call('review_change', { id: ids.site, outcome: 'meh' }, { 'x-founderdata-api-key': site.api_key });
      expect(bad.isError).toBe(true);

      const done = await call('review_change', { id: ids.site, outcome: 'reverted', comment: 'Banner cut revenue per visitor in half' }, { 'x-founderdata-api-key': site.api_key });
      expect(done.structuredContent).toMatchObject({ reviewed_now: true, note: { review: { outcome: 'reverted' } } });
      expect((await call('list_notes', { due: true, actor: 'site-agent' })).structuredContent.rows).toEqual([]);
    });

    itPro('reads one page, decay and opportunities', async () => {
      const page = await call('get_content', { path: '/blog/x', weeks: 4 });
      expect(page.structuredContent).toMatchObject({ path: '/blog/x', visitors: 30 });
      expect((await call('get_content', { path: 'blog/x' })).isError).toBe(true);
      const decay = await call('get_seo', { view: 'decay', limit: 5 });
      expect(decay.isError).toBeUndefined();
      expect(decay.structuredContent).toHaveProperty('pages');
      // The snapshot has no gsc_queries part, but pages are enough for the page list.
      const opp = await call('get_seo', { view: 'opportunities', days: 28 });
      expect(opp.isError).toBeUndefined();
      expect(opp.structuredContent).toMatchObject({ days: 28 });
      expect((await call('get_seo', { view: 'opportunities', days: 30 })).isError).toBe(true);
    });
  });
});
