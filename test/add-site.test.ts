// Adding a site (POST /api/sites) as a website, an iOS app or both; the note the dashboard shows when an app's events
// were refused because its site has no bundle id; and the last payment per provider that Settings shows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { startWorker, type TestWorker } from './helpers/worker';

describe('adding a site', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());
  beforeEach(() => resetBudgetForTests());

  const add = (json: Record<string, unknown>) => w.admin('/api/sites', { method: 'POST', json });
  const appBatch = (siteId: string, bundle: string) =>
    w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: siteId, vid: crypto.randomUUID(), ctx: { bundle_id: bundle }, events: [{ t: 'session_start', sid: crypto.randomUUID() }] }),
    });
  const listed = async (id: string) => (await w.admin('/api/sites')).body.find((s: any) => s.id === id);

  it('adds a website from a domain, as before', async () => {
    const res = await add({ domain: 'https://www.Example-Web.com/pricing', name: 'Web' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Web', domain: 'example-web.com', app_bundle_id: null });
  });

  it('adds an iOS app from a bundle id alone, with a placeholder domain no browser can send from', async () => {
    const res = await add({ name: 'Habit app', app_bundle_id: 'com.Example.Habits' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Habit app', domain: 'com.example.habits.invalid', app_bundle_id: 'com.Example.Habits' });
    // The app can send events right away: no 403 for its first launch.
    expect((await appBatch(res.body.id, 'com.Example.Habits')).status).toBe(202);
    // Without a name, the bundle id is the name.
    expect((await add({ app_bundle_id: 'com.example.noname' })).body.name).toBe('com.example.noname');
  });

  it('adds a website and an app together', async () => {
    const res = await add({ name: 'Both', domain: 'both.example.com', app_bundle_id: 'com.example.both' });
    expect(res.body).toMatchObject({ domain: 'both.example.com', app_bundle_id: 'com.example.both' });
    expect((await appBatch(res.body.id, 'com.example.both')).status).toBe(202);
  });

  it('refuses a bad bundle id, a bad domain and an empty form', async () => {
    expect(await add({ app_bundle_id: 'com example app' })).toMatchObject({ status: 400, body: { error: 'Enter a bundle id like com.example.app' } });
    expect(await add({ domain: 'localhost', app_bundle_id: 'com.example.ok' })).toMatchObject({ status: 400, body: { error: 'Enter a domain like example.com' } });
    expect(await add({ name: 'Nothing' })).toMatchObject({
      status: 400,
      body: { error: 'Enter a domain like example.com or a bundle id like com.example.app' },
    });
  });

  it('notes app events refused for a site without a bundle id, at most one row per 10 minutes', async () => {
    const site = (await add({ domain: 'nobundle.example.com' })).body;
    expect((await listed(site.id)).app_rejected_at).toBeNull();

    w.takeRowsWritten();
    const res = await appBatch(site.id, 'com.example.nobundle');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('set the app bundle id in the site settings first');
    await w.flush();
    expect(w.takeRowsWritten()).toBe(1);
    for (let i = 0; i < 5; i++) await appBatch(site.id, 'com.example.nobundle');
    await w.flush();
    expect(w.takeRowsWritten()).toBe(0);
    expect((await listed(site.id)).app_rejected_at).toBeGreaterThan(Date.now() - 60_000);

    // Once the bundle id is set, the note is moot and the list stops showing it.
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { app_bundle_id: 'com.example.nobundle' } });
    expect((await listed(site.id)).app_rejected_at).toBeNull();

    // A wrong bundle id on a site that has one is not noted, and deleting the site removes the note.
    w.takeRowsWritten();
    resetBudgetForTests();
    expect((await appBatch(site.id, 'com.example.other')).status).toBe(403);
    await w.flush();
    expect(w.takeRowsWritten()).toBe(0);
    await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' });
    expect(await w.db.prepare("SELECT 1 FROM site_usage WHERE site_id LIKE '%' || ?").bind(site.id).first()).toBeNull();
  });

  it('returns the last payment time per provider for the Settings status lines', async () => {
    const site = (await add({ domain: 'paying.example.com' })).body;
    expect((await w.admin(`/api/sites/${site.id}`)).body.last_payments).toEqual({});
    const res = await w.fetch('/api/v1/payments', {
      method: 'POST',
      headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transaction_id: 'txn_last_1', amount: 9.99, currency: 'USD' }),
    });
    expect(res.status).toBeLessThan(300);
    const last = (await w.admin(`/api/sites/${site.id}`)).body.last_payments;
    expect(Object.keys(last)).toEqual(['api']);
    expect(last.api).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('scripts/setup-sites.mjs with apps', () => {
  let w: TestWorker;
  let setupSites: any;
  const SCRIPT = '../scripts/setup-sites.mjs';
  const fetchVia = (url: string, init: RequestInit) => {
    const u = new URL(url);
    return w.fetch(u.pathname + u.search, { ...init, headers: { cookie: '', ...(init.headers as Record<string, string>) } });
  };
  const run = (sites: unknown[]) => setupSites({ base: 'https://stats.example/', password: 'test-password', sites, fetch: fetchVia });

  beforeAll(async () => {
    w = await startWorker();
    ({ setupSites } = await import(/* @vite-ignore */ SCRIPT));
  });
  afterAll(() => w.dispose());

  it('creates an app from its bundle id alone, finds it again by bundle id, and gives it a website later', async () => {
    const app = { name: 'Habits', app_bundle_id: 'com.example.habits' };
    const [created] = await run([app]);
    expect(created.action).toBe('created');
    expect(created.site).toMatchObject({ name: 'Habits', domain: 'com.example.habits.invalid', app_bundle_id: 'com.example.habits' });

    const [again] = await run([app]);
    expect(again).toMatchObject({ action: 'unchanged', site: { id: created.site.id } });

    const [both] = await run([{ ...app, domain: 'habits.example.com' }]);
    expect(both).toMatchObject({ action: 'updated', changed: ['domain'], site: { id: created.site.id, domain: 'habits.example.com' } });
    expect((await w.admin('/api/sites')).body).toHaveLength(1);
  });
});
