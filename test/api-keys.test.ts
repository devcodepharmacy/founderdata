// Scoped API keys (src/worker/keys.ts, docs/API.md "API keys"): creating and revoking them, the scope check on every
// /api/v1 route and every MCP tool, the old keys unchanged, usage per key, verdicts per actor, and the ASO verdict.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import openapi from '../public/openapi.json';
import { resetKeysForTests } from '../src/worker/keys';
import { tools } from '../src/worker/mcp';
import { resetShareCachesForTests } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const DAY = 86_400_000;

describe('scoped API keys', () => {
  let w: TestWorker;
  let site: any;
  let other: any;
  let noteId: string;
  /** Secrets by name. */
  const k: Record<string, string> = {};
  let n = 0;

  const as = (key: string | null, extra: Record<string, string> = {}) => ({ cookie: '', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra });
  const get = (path: string, key: string | null) => w.fetch(path, { headers: as(key) });
  const post = (path: string, key: string | null, json: unknown) => w.fetch(path, { method: 'POST', headers: as(key), json });
  const create = async (body: Record<string, unknown>) => {
    const r = await w.admin('/api/v1/keys', { method: 'POST', json: body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { id: string; key: string; scopes: string[]; sites: string[] | null };
  };
  const mcp = async (name: string, args: Record<string, unknown>, key: string, headers: Record<string, string> = {}) => {
    const res = await w.fetch('/mcp', {
      method: 'POST',
      headers: { ...as(key, headers), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return (await res.json<any>()).result;
  };

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shop.example.com', app_bundle_id: 'com.example.shop' });
    other = await w.createSite({ domain: 'other.example.com' });
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://shop.example.com/pricing', r: '', vid: 'alice-vid-0001', sid: 'alice-sid-0001' }),
    });
    await w.flush();
    await w.db
      .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, email, name, matched_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('pi_1', site.id, 'stripe', Date.now(), 4900, 'payment', 'USD', 'alice-vid-0001', 'alice-sid-0001', 'a@example.com', 'Alice', 'metadata')
      .run();
    await post('/api/v1/notes', site.api_key, { text: 'Raised Pro', actor: 'pricing-agent', kind: 'pricing', target: '/pricing' });
    const first = await (await post('/api/v1/notes', site.api_key, { text: 'New hero', actor: 'copy-agent', kind: 'copy', target: '/' })).json<any>();
    noteId = first.id;

    k.notes = (await create({ name: 'notes-only', scopes: ['notes:write'], sites: [site.id] })).key;
    k.read = (await create({ name: 'copy agent', scopes: ['read', 'notes:write'], sites: [site.id] })).key;
    k.revenue = (await create({ name: 'analyst', scopes: ['read:revenue'], sites: [site.id] })).key;
    k.payments = (await create({ name: 'billing', scopes: ['payments:write'], sites: [site.id] })).key;
    k.both = (await create({ name: 'two sites', scopes: ['read', 'notes:write'], sites: [site.id, other.id] })).key;
    k.all = (await create({ name: 'everything', scopes: ['read', 'read:revenue', 'notes:write', 'payments:write', 'alerts:write'] })).key;
    k.legacyRead = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
    k.legacyHidden = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: false } })).body.token;
  });
  afterAll(() => w?.dispose());
  beforeEach(() => {
    resetShareCachesForTests();
    resetKeysForTests();
  });

  /** Every GET route of the read API, from the OpenAPI spec, with the parameters it needs. */
  const readRoutes = () =>
    Object.entries((openapi as any).paths as Record<string, Record<string, unknown>>)
      // Routes with a key in their security; /api/v1/keys takes the admin login.
      .filter(([, ops]) => (ops.get as { security?: unknown[] } | undefined)?.security?.length)
      .map(([p]) => p.replace('{id}', noteId) + (p === '/api/v1/content/page' ? '?path=/' : ''));

  it('creates a key once, lists it without the secret, and is for the admin login only', async () => {
    const made = await create({ name: 'pricing-agent', scopes: ['read', 'notes:write'], sites: [site.id], expires_days: 30 });
    expect(made.key).toMatch(/^fdk_[a-z0-9]{48}$/);
    const list = await w.admin('/api/v1/keys');
    const row = list.body.find((r: any) => r.id === made.id);
    expect(row).toMatchObject({ name: 'pricing-agent', scopes: ['read', 'notes:write'], sites: [site.id], hint: made.key.slice(-4), calls_24h: 0, last_used_at: null });
    expect(JSON.stringify(list.body)).not.toContain(made.key);
    const stored = await w.db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(made.id).first<any>();
    expect(JSON.stringify(stored)).not.toContain(made.key);

    // A key can't make keys, and neither can no login.
    expect((await w.fetch('/api/v1/keys', { method: 'POST', headers: as(k.all), json: { name: 'x', scopes: ['read'] } })).status).toBe(401);
    expect((await get('/api/v1/keys', null)).status).toBe(401);
    // Bad bodies.
    for (const body of [{ scopes: ['read'] }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['admin'] }, { name: 'x', scopes: ['read'], sites: ['nope'] }, { name: 'x', scopes: ['read'], expires_days: 0 }]) {
      expect((await w.admin('/api/v1/keys', { method: 'POST', json: body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  itPro('a key with notes:write alone writes notes and gets 403 on payments, goals, erasures and every read route', async () => {
    const note = await post('/api/v1/notes', k.notes, { text: 'Changed the CTA', actor: 'cta-agent', kind: 'copy' });
    expect(note.status).toBe(200);
    const id = (await note.json<any>()).id;
    expect((await post(`/api/v1/notes/${id}/review`, k.notes, { outcome: 'kept' })).status).toBe(200);

    const pay = await post('/api/v1/payments', k.notes, { transaction_id: 'tx_1', amount: 9 });
    expect(pay.status).toBe(403);
    expect((await pay.json<any>()).error).toContain('payments:write');
    expect((await w.fetch('/api/v1/payments/tx_1', { method: 'DELETE', headers: as(k.notes) })).status).toBe(403);
    expect((await post('/api/v1/goals', k.notes, { visitor_id: 'alice-vid-0001', name: 'signup' })).status).toBe(403);
    expect((await post('/api/v1/erase', k.notes, { email: 'a@example.com' })).status).toBe(403);
    expect((await w.fetch('/api/v1/visitors/alice-vid-0001', { method: 'DELETE', headers: as(k.notes) })).status).toBe(403);

    // whoami answers every live key, whatever its scopes (agent-access.test.ts).
    const routes = [...readRoutes().filter((r) => r !== '/api/v1/whoami'), '/api/v1/notes/actors', '/api/v1/notes?due=true'];
    expect(routes.length).toBeGreaterThan(25);
    for (const r of routes) {
      const res = await get(r, k.notes);
      expect(res.status, r).toBe(403);
      expect((await res.json<any>()).error, r).toContain('read scope');
    }
  });

  itPro('a key with read but not read:revenue gets no revenue fields, and 403 on money routes and payment writes', async () => {
    const o = await (await get('/api/v1/stats/overview', k.read)).json<any>();
    expect(o.visitors).toBe(1);
    for (const f of ['revenue', 'payments', 'customers', 'conversion_rate', 'revenue_per_visitor']) expect(o).not.toHaveProperty(f);
    const ts = await (await get('/api/v1/stats/timeseries', k.read)).json<any>();
    expect(JSON.stringify(ts)).not.toContain('revenue');
    const content = await (await get('/api/v1/content', k.read)).json<any>();
    expect(JSON.stringify(content.rows)).not.toContain('revenue');
    for (const r of ['/api/v1/customers', '/api/v1/cohorts', '/api/v1/subscriptions', '/api/v1/asa']) expect((await get(r, k.read)).status, r).toBe(403);
    const def = await (await get('/api/v1/definitions', k.read)).json<any>();
    expect(def).toMatchObject({ show_revenue: false, scopes: ['read', 'notes:write'] });
    expect((await post('/api/v1/payments', k.read, { transaction_id: 'tx_2', amount: 9 })).status).toBe(403);
    // Every read route answers: 200, or 403 for the money routes, never 401.
    for (const r of readRoutes()) {
      const status = (await get(r, k.read)).status;
      expect([200, 403, 404], `${r}: ${status}`).toContain(status);
      // The raw rows route needs read:rows, which this key does not have.
      if (status === 403) expect(['/api/v1/customers', '/api/v1/cohorts', '/api/v1/subscriptions', '/api/v1/asa', '/api/v1/asa/campaigns', '/api/v1/meta', '/api/v1/appstore', '/api/v1/portfolio', '/api/v1/export/{table}']).toContain(r);
    }
  });

  it('read:revenue shows revenue, and payments:write sends payments', async () => {
    const o = await (await get('/api/v1/stats/overview', k.revenue)).json<any>();
    expect(o.revenue).toBe(4900);
    expect((await get('/api/v1/customers', k.revenue)).status).toBe(200);
    expect((await post('/api/v1/notes', k.revenue, { text: 'x' })).status).toBe(403);
    const pay = await post('/api/v1/payments', k.payments, { transaction_id: 'tx_scoped', amount: 19 });
    expect(pay.status).toBe(200);
    expect((await get('/api/v1/stats/overview', k.payments)).status).toBe(403);
    expect((await w.fetch('/api/v1/payments/tx_scoped', { method: 'DELETE', headers: as(k.payments) })).status).toBe(200);
  });

  itPro('a key for some sites names the site, and gets 403 for a site it does not cover', async () => {
    expect((await get('/api/v1/stats/overview', k.both)).status).toBe(400);
    expect((await get(`/api/v1/stats/overview?site=${other.id}`, k.both)).status).toBe(200);
    const third = await w.createSite({ domain: 'third.example.com' });
    expect((await get(`/api/v1/stats/overview?site=${third.id}`, k.both)).status).toBe(403);
    expect((await post('/api/v1/notes', k.both, { text: 'x' })).status).toBe(400);
    expect((await post(`/api/v1/notes?site=${other.id}`, k.both, { text: 'Launch' })).status).toBe(200);
    expect((await post(`/api/v1/notes?site=${third.id}`, k.both, { text: 'x' })).status).toBe(403);
    // A one-site key never reaches another site, with or without ?site=.
    expect((await get(`/api/v1/stats/overview?site=${other.id}`, k.read)).status).toBe(403);
    // The portfolio and the weekly report list only the key's sites.
    const p = await (await get('/api/v1/portfolio', k.both)).json<any>();
    expect(p.sites.map((s: any) => s.id).sort()).toEqual([site.id, other.id].sort());
    expect(p.totals.sites).toBe(2);
    const all = await (await get('/api/v1/portfolio', k.all)).json<any>();
    expect(all.sites.length).toBe(3);
    const weekly = await (await get('/api/v1/weekly', k.both)).json<any>();
    expect(weekly.sites.every((s: any) => [site.id, other.id].includes(s.id))).toBe(true);
  });

  it('expired and revoked keys get 401', async () => {
    const made = await create({ name: 'short', scopes: ['read'], sites: [site.id], expires_days: 1 });
    expect((await get('/api/v1/stats/overview', made.key)).status).toBe(200);
    await w.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, made.id).run();
    resetKeysForTests();
    expect((await get('/api/v1/stats/overview', made.key)).status).toBe(401);

    const gone = await create({ name: 'gone', scopes: ['read', 'notes:write'], sites: [site.id] });
    expect((await get('/api/v1/stats/overview', gone.key)).status).toBe(200);
    expect((await w.admin(`/api/v1/keys/${gone.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('/api/v1/stats/overview', gone.key)).status).toBe(401);
    expect((await post('/api/v1/notes', gone.key, { text: 'x' })).status).toBe(401);
    expect((await w.admin(`/api/v1/keys/${gone.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('the old keys work as before', async () => {
    const o = await (await get('/api/v1/stats/overview', k.legacyRead)).json<any>();
    expect(o.revenue).toBe(4900);
    const hidden = await (await get('/api/v1/stats/overview', k.legacyHidden)).json<any>();
    expect(hidden).not.toHaveProperty('revenue');
    expect((await get('/api/v1/customers', k.legacyHidden)).status).toBe(403);
    // A read key can't write; the site API key writes payments and notes and reads nothing.
    expect((await post('/api/v1/notes', k.legacyRead, { text: 'x' })).status).toBe(401);
    expect((await post('/api/v1/notes', site.api_key, { text: 'Deploy' })).status).toBe(200);
    expect((await post('/api/v1/payments', site.api_key, { transaction_id: 'tx_legacy', amount: 5 })).status).toBe(200);
    expect((await get('/api/v1/stats/overview', site.api_key)).status).toBe(401);
    const def = await (await get('/api/v1/definitions', k.legacyRead)).json<any>();
    expect(def.scopes).toEqual(['read', 'read:revenue']);
  });

  itPro('MCP: one scoped key reads and writes; each tool follows the key scopes', async () => {
    // A read and notes key: add_note works with the one Authorization header.
    const added = await mcp('add_note', { text: 'Shorter signup form', actor: 'form-agent', kind: 'copy' }, k.read);
    expect(added.isError).toBeUndefined();
    expect(added.structuredContent.created).toBe(true);
    // Without notes:write, add_note and review_change answer 403 with the scope named.
    const refused = await mcp('add_note', { text: 'x' }, k.revenue);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('403');
    expect(refused.content[0].text).toContain('notes:write');
    expect((await mcp('review_change', { id: noteId, outcome: 'kept' }, k.revenue)).content[0].text).toContain('403');
    // A notes-only key: every read tool answers 403, never revenue.
    for (const t of tools()) {
      // whoami answers every live key, whatever its scopes.
      if (t.annotations.readOnlyHint !== true || t.name === 'get_portfolio' || t.name === 'whoami') continue;
      const args: Record<string, unknown> = { id: noteId, path: '/', view: 'summary', report: 'paths', metrics: ['visitors'] };
      const props = (t.inputSchema as any).properties ?? {};
      const fits = ([a, v]: [string, unknown]) => a in props && (!props[a].enum || props[a].enum.includes(v));
      const r = await mcp(t.name, Object.fromEntries(Object.entries(args).filter(fits)), k.notes);
      expect(r.isError, t.name).toBe(true);
      expect(r.content[0].text, t.name).toContain('403');
    }
    // A read key without revenue gets none from get_overview.
    const o = await mcp('get_overview', {}, k.read);
    expect(o.structuredContent).not.toHaveProperty('revenue');
    // A read key (rtr_) alone can't write; with the site API key in X-FounderData-Api-Key it still can.
    const old = await mcp('add_note', { text: 'x' }, k.legacyRead);
    expect(old.isError).toBe(true);
    expect(old.content[0].text).toContain('notes:write');
    const both = await mcp('add_note', { text: 'Old setup' }, k.legacyRead, { 'x-founderdata-api-key': site.api_key });
    expect(both.isError).toBeUndefined();
    // An unknown key is refused before any tool runs.
    const res = await w.fetch('/mcp', { method: 'POST', headers: { ...as('fdk_' + 'x'.repeat(48)), 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('counts usage per key with at most one write a minute', async () => {
    const made = await create({ name: 'counter', scopes: ['read', 'notes:write'], sites: [site.id] });
    const row = async () => (await w.admin('/api/v1/keys')).body.find((r: any) => r.id === made.id);
    w.takeRowsWritten();
    await get('/api/v1/definitions', made.key);
    await w.flush();
    expect(w.takeRowsWritten()).toBe(1);
    let r = await row();
    expect(r.calls_24h).toBe(1);
    expect(r.last_used_at).toBeGreaterThan(Date.now() - 60_000);
    expect(r.last_write_at).toBeNull();
    // Within the minute: counted in memory, nothing written.
    await post('/api/v1/notes', made.key, { text: 'x', idempotency_key: 'usage-1' });
    await get('/api/v1/definitions', made.key);
    await w.flush();
    w.takeRowsWritten();
    expect((await row()).calls_24h).toBe(1);
    // A minute later the next call writes all three.
    const later = Date.now() + 61_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await get('/api/v1/definitions', made.key);
      await w.flush();
      expect(w.takeRowsWritten()).toBe(1);
    } finally {
      spy.mockRestore();
    }
    r = await row();
    expect(r.calls_24h).toBe(4);
    expect(r.last_write_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('verdicts per actor, on the API and in MCP', async () => {
    const now = Date.now();
    const old = (ts: number, actor: string, outcome: string | null) =>
      w.db
        .prepare('INSERT INTO notes (id, site_id, ts, text, kind, created_at, actor, change_kind, reviewed_at, review_outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(`n_${actor}_${ts}`, site.id, ts, 'x', 'api', ts, actor, 'copy', outcome ? now : null, outcome)
        .run();
    await old(now - 20 * DAY, 'seo-agent', 'kept');
    await old(now - 15 * DAY, 'seo-agent', null);
    await old(now - 2 * DAY, 'seo-agent', null);
    const out = await (await get('/api/v1/notes/actors', k.read)).json<any>();
    const seo = out.actors.find((a: any) => a.actor === 'seo-agent');
    expect(seo).toMatchObject({ changes: 3, measuring: 1, inconclusive: 2, better: 0, worse: 0, reviewed: 1, kept: 1 });
    expect(out.actors.some((a: any) => a.actor === null)).toBe(false);
    expect((await get('/api/v1/notes/actors?days=0', k.read)).status).toBe(400);
    const tool = await mcp('list_notes', { view: 'actors' }, k.read);
    expect(tool.structuredContent.actors.find((a: any) => a.actor === 'seo-agent').changes).toBe(3);
    expect((await w.admin(`/api/sites/${site.id}/notes/actors`)).body.actors.length).toBeGreaterThan(0);
  });

  it('an ASO note is judged by the keyword rank, not by revenue per visitor', async () => {
    const now = Date.now();
    const noteTs = now - 10 * DAY;
    const snap = (country: string, ts: number, rank: number | null) =>
      w.db
        .prepare('INSERT INTO aso_snapshots (site_id, country, day, collected_at, app_id, ranks, top) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(site.id, country, new Date(ts).toISOString().slice(0, 10), ts, '1', JSON.stringify({ 'habit tracker': [rank, 250, {}], other: [5, 250, {}] }), '{}')
        .run();
    await snap('de', noteTs - 2 * DAY, 34);
    await snap('de', noteTs + 6 * DAY, 26);
    await snap('us', noteTs - 1 * DAY, 12);
    await snap('us', noteTs + 5 * DAY, 11);
    const note = async (target: string) =>
      (await (await post('/api/v1/notes', site.api_key, { text: 'New subtitle', kind: 'aso', target, actor: 'aso-agent', timestamp: new Date(noteTs).toISOString() })).json<any>()).id;
    const impact = async (id: string, key = k.read) => (await get(`/api/v1/notes/${id}/impact`, key)).json<any>();

    const de = await impact(await note('keyword:habit tracker@de'));
    expect(de).toMatchObject({ scope: 'keyword', verdict: 'better', verdict_metric: 'keyword_rank', enough_data: true });
    expect(de.keyword).toMatchObject({ term: 'habit tracker', country: 'de' });
    expect(de.keyword.countries[0]).toMatchObject({ country: 'de', moved: 8, verdict: 'better', before: { rank: 34 }, after: { rank: 26 } });
    expect(de.reason).toContain('#34 → #26');
    expect(de.change.keyword_rank.absolute).toBe(8);

    // Every country: DE rose 8, US 1 (less than 3 places): better, with the rank moves listed.
    const all = await impact(await note('keyword:Habit  Tracker'), k.revenue);
    expect(all.verdict).toBe('better');
    expect(all.keyword.countries.length).toBe(2);
    expect(all.reason).toMatch(/rose in 1 of 2 countries/);

    // Off the results counts as one place below the last: worse.
    await snap('gb', noteTs - DAY, 40);
    await snap('gb', noteTs + 4 * DAY, null);
    const gb = await impact(await note('keyword:habit tracker@gb'));
    expect(gb).toMatchObject({ verdict: 'worse' });
    expect(gb.reason).toContain('not ranked');

    // A keyword with no snapshot: inconclusive, still not revenue per visitor.
    const none = await impact(await note('keyword:meditation timer'));
    expect(none).toMatchObject({ scope: 'keyword', verdict: 'inconclusive', enough_data: false });
    expect(none.reason).toContain('No ASO snapshot');
    // A copy note with the same target is judged as before.
    const copy = await (await post('/api/v1/notes', site.api_key, { text: 'x', kind: 'copy', target: 'keyword:habit tracker', timestamp: new Date(noteTs).toISOString() })).json<any>();
    expect((await impact(copy.id)).scope).toBe('site');
  });
});
