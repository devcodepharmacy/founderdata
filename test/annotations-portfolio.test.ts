// Annotations, impact and the portfolio (docs/API.md "POST /api/v1/notes", "GET /api/v1/notes/<id>/impact",
// "Portfolio"): agents log a change with who, what and before/after, read how the numbers moved after it, and one
// all-sites read key reads every site.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IMPACT_MIN_CUSTOMERS, IMPACT_MIN_LIFT, IMPACT_MIN_VISITORS } from '../src/worker/notes';
import { resetShareCachesForTests } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const DAY = 86_400_000;

describe('annotations, impact and portfolio', () => {
  let w: TestWorker;
  let site: any;
  let other: any;
  let key: string;
  let allKey: string;
  const now = Date.now();
  /** The note the impact tests read: 10 days ago, so its 7 days after are over. */
  const T = now - 10 * DAY;

  const bearer = (k: string | null): Record<string, string> => (k ? { cookie: '', authorization: `Bearer ${k}` } : { cookie: '' });
  const get = (path: string, k: string | null = key) => w.fetch(path, { headers: bearer(k) });
  const json = async (path: string, k: string | null = key) => {
    const res = await get(path, k);
    expect(res.status, `${path}: ${res.status}`).toBe(200);
    return res.json<any>();
  };
  const postNote = (body: unknown, apiKey = site.api_key) =>
    w.fetch('/api/v1/notes', { method: 'POST', json: body, headers: { cookie: '', authorization: `Bearer ${apiKey}` } });

  /**
   * `n` visitors with one session each, spread over the day after `from`; the first `buyers` pay `amount` each. Every
   * visit enters on /pricing, the target of the note the impact tests read, so its page scope counts them all.
   */
  async function seed(s: any, prefix: string, from: number, n: number, buyers: number, amount: number) {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < n; i++) {
      const at = from + 3_600_000 + i * 60_000;
      const vid = `${prefix}-v${i}`;
      stmts.push(
        w.db
          .prepare(
            `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, hostname, source, channel, entry_page)
             VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, 'Google', 'Organic Search', '/pricing')`,
          )
          .bind(s.id, `${prefix}-s${i}`, vid, at, at, s.domain),
      );
      if (i < buyers) {
        stmts.push(
          w.db
            .prepare(
              `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, matched_by)
               VALUES (?, ?, 'stripe', ?, ?, 'payment', 'USD', ?, ?, 'metadata')`,
            )
            .bind(`${prefix}-p${i}`, s.id, at + 1000, amount, vid, `${prefix}-s${i}`),
        );
      }
    }
    await w.db.batch(stmts);
  }

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shipkit.example.com' });
    other = await w.createSite({ domain: 'other.example.com' });
    // Before the note: 120 visitors, 6 pay $10. After: 150 visitors, 10 pay $15. One more visitor 8 days before
    // the note, outside both windows.
    await seed(site, 'before', T - 7 * DAY, 120, 6, 1000);
    await seed(site, 'after', T, 150, 10, 1500);
    await seed(site, 'old', T - 8 * DAY - 2 * 3_600_000, 1, 0, 0);
    await seed(other, 'o', now - 2 * DAY, 3, 1, 500);
    key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
    allKey = (await w.admin('/api/read-keys', { method: 'POST', json: { label: 'Portfolio agent' } })).body.token;
  });
  afterAll(() => w?.dispose());
  beforeEach(() => resetShareCachesForTests());

  describe('annotations', () => {
    it('stores who, what kind, where and before and after, and keeps the old body working', async () => {
      const plain = await postNote({ text: 'Deployed v2.3', timestamp: new Date(T - 3 * DAY).toISOString() });
      expect(await plain.json()).toMatchObject({ ok: true, created: true, note: { kind: null, origin: 'api', actor: null, before: null } });
      const res = await postNote({
        text: 'Raised Pro to $24',
        timestamp: T,
        kind: 'pricing',
        actor: 'pricing-agent',
        target: '/pricing',
        before: '$19',
        after: '$24',
        idempotency_key: 'pricing-1',
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body).toMatchObject({
        ok: true,
        created: true,
        ts: T,
        note: { kind: 'pricing', origin: 'api', actor: 'pricing-agent', target: '/pricing', before: '$19', after: '$24', idempotency_key: 'pricing-1' },
      });
      // The dashboard keeps `kind` for where the note came from and calls the change `change_kind`.
      const list = (await w.admin(`/api/sites/${site.id}/notes?period=30d`)).body;
      expect(list.find((n: any) => n.id === body.id)).toMatchObject({ kind: 'api', change_kind: 'pricing', actor: 'pricing-agent', before: '$19', after: '$24' });
    });

    it('returns the first note for a repeated idempotency key, and stores it once', async () => {
      const first = await (await postNote({ text: 'Rewrote the hero', kind: 'copy', actor: 'landing-agent', idempotency_key: 'hero-7' })).json<any>();
      w.takeRowsWritten();
      const again = await postNote({ text: 'Rewrote the hero, again', kind: 'copy', actor: 'landing-agent', idempotency_key: 'hero-7' });
      expect(again.status).toBe(200);
      const body = await again.json<any>();
      expect(body).toMatchObject({ ok: true, created: false, id: first.id, note: { text: 'Rewrote the hero' } });
      expect(w.takeRowsWritten()).toBe(0);
      const n = await w.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE site_id = ? AND idempotency_key = ?').bind(site.id, 'hero-7').first<{ n: number }>();
      expect(n!.n).toBe(1);
      // The key is per site: another site stores its own note.
      const theirs = await (await postNote({ text: 'Rewrote the hero', idempotency_key: 'hero-7' }, other.api_key)).json<any>();
      expect(theirs.created).toBe(true);
      expect(theirs.id).not.toBe(first.id);
      // Without a key, the same note twice is two notes, as before.
      const a = await (await postNote({ text: 'Same twice' })).json<any>();
      const b = await (await postNote({ text: 'Same twice' })).json<any>();
      expect(a.id).not.toBe(b.id);
    });

    it('checks kind and the length of each field', async () => {
      expect((await postNote({ text: 'x', kind: 'vibes' })).status).toBe(400);
      expect((await postNote({ text: 'x', actor: 'a'.repeat(65) })).status).toBe(400);
      expect((await postNote({ text: 'x', target: 'a'.repeat(201) })).status).toBe(400);
      expect((await postNote({ text: 'x', before: 7 })).status).toBe(400);
      expect((await (await postNote({ text: 'x', before: 7 })).json<any>()).error).toMatch(/before/);
    });

    it('filters GET /api/v1/notes by actor and kind', async () => {
      const range = 'period=30d';
      expect((await json(`/api/v1/notes?${range}&actor=pricing-agent`)).map((n: any) => n.text)).toEqual(['Raised Pro to $24']);
      expect((await json(`/api/v1/notes?${range}&kind=copy`)).map((n: any) => n.actor)).toEqual(['landing-agent']);
      expect(await json(`/api/v1/notes?${range}&kind=copy&actor=pricing-agent`)).toEqual([]);
      const all = await json(`/api/v1/notes?${range}`);
      expect(all.length).toBeGreaterThanOrEqual(5);
      expect(all[0]).toHaveProperty('bucket');
      expect(all[0]).toHaveProperty('origin');
      expect((await get(`/api/v1/notes?${range}&kind=vibes`)).status).toBe(400);
    });
  });

  describe('impact', () => {
    let noteId: string;
    beforeAll(async () => {
      noteId = (await json('/api/v1/notes?period=30d&actor=pricing-agent'))[0].id;
      // Two days after the pricing note: it overlaps.
      await postNote({ text: 'New screenshots', kind: 'aso', timestamp: T + 2 * DAY });
    });

    it('compares the 7 days after a note with the 7 days before', async () => {
      w.takeRowsWritten();
      const i = await json(`/api/v1/notes/${noteId}/impact`);
      expect(w.takeRowsWritten()).toBe(0);
      expect(i).toMatchObject({ site_id: site.id, currency: 'USD', currency_decimals: 2, window_days: 7, days_covered: 7, complete: true, enough_data: true });
      expect(i).toMatchObject({ scope: 'page', page: '/pricing', verdict: 'better', verdict_metric: 'revenue_per_visitor' });
      expect(i.note).toMatchObject({ id: noteId, kind: 'pricing', before: '$19', after: '$24' });
      expect(i.before).toMatchObject({ from: new Date(T - 7 * DAY).toISOString(), to: new Date(T).toISOString() });
      expect(i.before).toMatchObject({ visitors: 120, customers: 6, conversion_rate: 0.05, revenue: 6000, revenue_per_visitor: 50 });
      expect(i.after).toMatchObject({ visitors: 150, customers: 10, conversion_rate: 0.0667, revenue: 15000, revenue_per_visitor: 100 });
      expect(i.change).toEqual({
        visitors: { absolute: 30, relative: 0.25 },
        customers: { absolute: 4, relative: 0.6667 },
        conversion_rate: { absolute: 0.0167, relative: 0.3333 },
        revenue: { absolute: 9000, relative: 1.5 },
        revenue_per_visitor: { absolute: 50, relative: 1 },
      });
      expect(i.thresholds).toEqual({ min_visitors: IMPACT_MIN_VISITORS, min_customers: IMPACT_MIN_CUSTOMERS, min_lift: IMPACT_MIN_LIFT });
      expect(i.overlapping.map((n: any) => n.text)).toEqual(['New screenshots']);
      // The dashboard's route gives the same verdict; the read API adds the link to the Changes tab.
      const { dashboard_url, ...verdict } = i;
      expect(dashboard_url).toBe(`http://localhost/site/${site.id}?tab=changes`);
      expect((await w.admin(`/api/sites/${site.id}/notes/${noteId}/impact`)).body).toEqual(verdict);
    });

    it('takes ?window= from 1 to 28 days', async () => {
      const one = await json(`/api/v1/notes/${noteId}/impact?window=1`);
      expect(one.window_days).toBe(1);
      expect(one.overlapping).toEqual([]);
      // Before: the day before the note has no visitors; after: the first day has all 150 (they start an hour in).
      expect(one.after.visitors).toBe(150);
      expect(one.change.visitors.relative).toBeNull();
      expect(one.enough_data).toBe(false);
      for (const bad of ['0', '29', '2.5', 'week']) expect((await get(`/api/v1/notes/${noteId}/impact?window=${bad}`)).status, bad).toBe(400);
    });

    it('says when there is not enough data yet, and covers only the days that have passed', async () => {
      const recent = await (await postNote({ text: 'Launched on HN', kind: 'launch', timestamp: now - 2 * DAY })).json<any>();
      const i = await json(`/api/v1/notes/${recent.id}/impact`);
      expect(i.complete).toBe(false);
      expect(i.days_covered).toBeGreaterThan(1.99);
      expect(i.days_covered).toBeLessThan(2.01);
      expect(i.enough_data).toBe(false);
    });

    it('answers 404 for a note of another site, and leaves revenue out for a key without it', async () => {
      const theirs = (await w.db.prepare('SELECT id FROM notes WHERE site_id = ? LIMIT 1').bind(other.id).first<{ id: string }>())!.id;
      expect((await get(`/api/v1/notes/${theirs}/impact`)).status).toBe(404);
      expect((await get('/api/v1/notes/nope/impact')).status).toBe(404);
      expect((await w.admin(`/api/sites/${site.id}/notes/${theirs}/impact`)).status).toBe(404);
      const k = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: false } })).body.token;
      const i = await json(`/api/v1/notes/${noteId}/impact`, k);
      expect(JSON.stringify(i)).not.toMatch(/revenue|customers|conversion/);
      expect(i.after).toEqual({ from: expect.any(String), to: expect.any(String), visitors: 150 });
      expect(i.enough_data).toBe(true);
    });
  });

  describe('portfolio and the all-sites key', () => {
    itPro('reads every site with an all-sites key, and writes nothing', async () => {
      w.takeRowsWritten();
      const p = await json('/api/v1/portfolio?period=30d', allKey);
      expect(w.takeRowsWritten()).toBe(0);
      expect(p).toMatchObject({ period: '30d', timezone: 'UTC', show_revenue: true });
      const mine = p.sites.find((s: any) => s.id === site.id);
      const theirs = p.sites.find((s: any) => s.id === other.id);
      expect(mine).toMatchObject({ kind: 'web', currency: 'USD', revenue: 21000, new_customers: 16, visitors: 271, top_source: 'Google', mrr: null });
      // new: the site's data started after the period before began, so there is nothing to compare with.
      expect(['growing', 'flat', 'declining', 'quiet', 'no_payments', 'new']).toContain(mine.status);
      expect(Array.isArray(mine.alerts)).toBe(true);
      expect(theirs).toMatchObject({ revenue: 500, new_customers: 1, visitors: 3 });
      expect(p.totals).toMatchObject({ sites: 2, visitors: 274, revenue: { USD: 21500 }, new_customers: 17 });
      // The dashboard login reads the same.
      expect((await w.admin('/api/v1/portfolio?period=30d')).body.sites.length).toBe(2);
    });

    itPro('refuses a per-site key and no key', async () => {
      expect((await get('/api/v1/portfolio', key)).status).toBe(403);
      expect((await get('/api/v1/portfolio', null)).status).toBe(401);
      expect((await get('/api/v1/portfolio', 'rtr_nope_nope_nope_nope')).status).toBe(401);
    });

    it('reads each per-site route with ?site=', async () => {
      const a = await json(`/api/v1/stats/overview?period=30d&site=${site.id}`, allKey);
      const b = await json(`/api/v1/stats/overview?period=30d&site=${other.id}`, allKey);
      expect(a.site_id).toBe(site.id);
      expect(b.site_id).toBe(other.id);
      expect(a.visitors).not.toBe(b.visitors);
      expect((await json(`/api/v1/notes?period=30d&site=${site.id}&kind=pricing`, allKey)).length).toBe(1);
      expect((await get('/api/v1/stats/overview', allKey)).status).toBe(400);
      expect((await get('/api/v1/content?site=nope', allKey)).status).toBe(404);
      // A per-site key ignores ?site=.
      expect((await json(`/api/v1/stats/overview?period=30d&site=${other.id}`, key)).site_id).toBe(site.id);
    });

    itPro('is listed, made without revenue and revoked under /api/read-keys', async () => {
      const list = (await w.admin('/api/read-keys')).body;
      expect(list).toEqual([expect.objectContaining({ token: allKey, kind: 'all', site_id: '*', label: 'Portfolio agent' })]);
      // A site's own list does not show it.
      expect((await w.admin(`/api/sites/${site.id}/share`)).body.map((t: any) => t.token)).not.toContain(allKey);
      const quiet = (await w.admin('/api/read-keys', { method: 'POST', json: { show_revenue: false } })).body.token;
      const p = await json('/api/v1/portfolio', quiet);
      expect(p.show_revenue).toBe(false);
      for (const f of ['revenue', 'revenue_previous', 'mrr', 'mrr_previous', 'new_customers', 'status']) {
        expect(p.sites[0], f).not.toHaveProperty(f);
        expect(p.totals, f).not.toHaveProperty(f);
      }
      expect(p.sites[0]).toHaveProperty('visitors');
      expect((await w.admin(`/api/read-keys/${quiet}`, { method: 'DELETE' })).status).toBe(200);
      expect((await get('/api/v1/portfolio', quiet)).status).toBe(401);
    });
  });
});
