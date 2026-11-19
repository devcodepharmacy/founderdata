// People and recordings, core's part (migration 0072, docs/API.md "The tracker"): the tracker config on the pageview
// answer, page activity on the ping, identify() traits, the site settings, and the hooks FounderData Pro fills.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TRAITS, parseActivity, traitsOf } from '../src/worker/collect';
import { forgetSite } from '../src/worker/env';
import { installPro, proHooks, type Pro, type RecordConfig } from '../src/worker/pro-hooks';
import { patchRecording } from '../src/worker/recording';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const REC: RecordConfig = { mask: '[data-fd-mask]', block: '[data-fd-block]', v: '1' };

describe('parseActivity', () => {
  it('keeps checked clicks and errors, newest 30 clicks and 5 errors, and drops the rest', () => {
    const clicks = Array.from({ length: 40 }, (_, i) => ({ t: i * 100, l: `  Button\n ${i} `, k: 'button' }));
    const a = parseActivity({ p: '/pricing/?x=1', s: 1_767_225_600_000, c: clicks, e: Array.from({ length: 7 }, (_, i) => ({ t: i, m: `E${i}`, s: 'app.js:1' })) })!;
    const props = JSON.parse(a.props);
    expect(a.path).toBe('/pricing');
    expect(props.s).toBe(1_767_225_600_000);
    expect(props.c).toHaveLength(30);
    expect(props.c[0]).toEqual({ t: 1000, l: 'Button 10', k: 'button' });
    expect(props.e.map((e: any) => e.m)).toEqual(['E2', 'E3', 'E4', 'E5', 'E6']);
  });

  it('marks a rage click only with 3 or more clicks, and checks every field', () => {
    const a = parseActivity({
      c: [
        { t: 1, l: 'Buy', k: 'button', n: 5, r: 1 },
        { t: 2, l: 'Twice', k: 'link', n: 2, r: 1 },
        { t: 3, l: 'Odd kind', k: 'script' },
        { t: -1, l: 'Bad time', k: 'button' },
        { t: 4, l: '', k: 'button' },
        { t: 5, l: 'x'.repeat(80), k: 'submit' },
        'nope',
      ],
      e: [{ t: 1, m: '', s: '' }, { t: 2, m: 'TypeError: boom', s: 7 }],
    })!;
    const props = JSON.parse(a.props);
    expect(props.c).toEqual([
      { t: 1, l: 'Buy', k: 'button', n: 5, r: 1 },
      { t: 2, l: 'Twice', k: 'link', n: 2 },
      { t: 3, l: 'Odd kind', k: 'other' },
      { t: 5, l: 'x'.repeat(40), k: 'submit' },
    ]);
    expect(props.e).toEqual([{ t: 2, m: 'TypeError: boom', s: '' }]);
    expect(a.path).toBeNull();
  });

  it('is null when nothing is left', () => {
    expect(parseActivity(undefined)).toBeNull();
    expect(parseActivity([])).toBeNull();
    expect(parseActivity({ c: [], e: [] })).toBeNull();
    expect(parseActivity({ c: [{ t: 1 }] })).toBeNull();
  });
});

describe('traitsOf', () => {
  it('keeps extra keys as text, lowercased, without the identity fields', () => {
    expect(JSON.parse(traitsOf({ user_id: 'u1', id: 'x', email: 'a@acme.example', name: 'Anna', Plan: 'Pro', seats: 5, trial: true, note: ' '.repeat(3) + 'y'.repeat(120) })!)).toEqual({
      plan: 'Pro',
      seats: '5',
      trial: 'true',
      note: 'y'.repeat(100),
    });
  });

  it('drops bad keys and values, and keeps at most 20', () => {
    expect(traitsOf({ 'bad key': 'x', 'ü': 'x', ['k'.repeat(41)]: 'x', empty: '', nul: null, obj: { a: 1 }, arr: [1], inf: Infinity })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(JSON.parse(traitsOf(many)!))).toHaveLength(MAX_TRAITS);
  });
});

describe('patchRecording', () => {
  it('takes switches and numbers in range, and refuses the rest', () => {
    const next: any = {};
    expect(patchRecording({ record_visits: true, remember_visitors: 0, record_only_active: 1, record_sample: 25, record_keep_days: 90, record_daily_max: 500 }, next)).toBeNull();
    expect(next).toEqual({ record_visits: 1, remember_visitors: 0, record_only_active: 1, record_sample: 25, record_keep_days: 90, record_daily_max: 500 });
    expect(patchRecording({ record_sample: 0 }, {} as any)).toMatch(/1 to 100/);
    expect(patchRecording({ record_sample: 50.5 }, {} as any)).toMatch(/1 to 100/);
    expect(patchRecording({ record_keep_days: 14 }, {} as any)).toMatch(/7, 30 or 90/);
    expect(patchRecording({ record_daily_max: 0 }, {} as any)).toMatch(/most visits a day/);
  });
});

describe('people and recordings in the Worker', () => {
  let w: TestWorker;
  let site: any;
  const bucket = {} as R2Bucket;
  const decisions: { siteId: string; sid: string }[] = [];
  const erased: string[][] = [];
  let decide: Pro['recordDecision'] = async (_env, s, sid) => {
    decisions.push({ siteId: s.id, sid });
    return REC;
  };
  const before = proHooks();
  let fake: Pro;

  const event = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.21', cookie: '', ...headers },
      body: JSON.stringify({ w: site.id, u: 'https://people.example/pricing', sw: 1440, ...body }),
    });
  const answer = async (r: Response) => ({ status: r.status, text: await r.text() });
  const setSite = async (patch: Record<string, unknown>) => {
    const r = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: patch });
    expect(r.status).toBe(200);
    forgetSite(site.id);
    return r.body;
  };

  beforeAll(async () => {
    w = await startWorker({ REPLAY_BUCKET: bucket });
    site = await w.createSite({ domain: 'people.example' });
    fake = {
      ...(before ?? {}),
      recordDecision: (...a) => decide!(...a),
      eraseRecordings: async ({ site: s, visitorIds }) => {
        erased.push(visitorIds);
        const r = await w.db.prepare(`DELETE FROM replays WHERE site_id = ? AND visitor_id IN (${visitorIds.map(() => '?').join(',')})`).bind(s.id, ...visitorIds).run();
        return { recordings: r.meta.changes };
      },
    };
    installPro(fake);
  });
  afterAll(async () => {
    installPro(before);
    await w.dispose();
  });
  beforeEach(() => {
    decisions.length = 0;
  });

  it('stores the new site settings with their defaults, and says whether the bucket is bound', async () => {
    const got = (await w.admin(`/api/sites/${site.id}`)).body;
    expect(got).toMatchObject({ record_visits: 0, record_sample: 100, record_keep_days: 30, record_daily_max: 1000, record_only_active: 0, remember_visitors: 0, replay_bucket: true });
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { record_keep_days: 3 } })).status).toBe(400);
    const patched = await setSite({ record_sample: 50, record_keep_days: 7 });
    expect(patched).toMatchObject({ record_sample: 50, record_keep_days: 7, replay_bucket: true });
    await setSite({ record_sample: 100, record_keep_days: 30 });
  });

  it('answers a pageview as before while both switches are off, and asks Pro nothing', async () => {
    const cookieless = await answer(await event({ t: 'pageview' }));
    expect(cookieless.status).toBe(202);
    expect(Object.keys(JSON.parse(cookieless.text)).sort()).toEqual(['sid', 'vid']);
    const cookie = await answer(await event({ t: 'pageview', vid: 'cookievisitor01', sid: 'cookiesession01' }));
    expect(cookie).toEqual({ status: 202, text: '' });
    expect(decisions).toEqual([]);
  });

  it('carries rm in both modes when Remember visitors is on', async () => {
    await setSite({ remember_visitors: 1 });
    const cookieless = JSON.parse((await answer(await event({ t: 'pageview' }))).text);
    expect(cookieless).toMatchObject({ cfg: { rm: 1 } });
    expect(cookieless.vid).toBeTruthy();
    expect(JSON.parse((await answer(await event({ t: 'pageview', vid: 'cookievisitor01', sid: 'cookiesession01' }))).text)).toEqual({ cfg: { rm: 1 } });
    // Only a pageview carries it.
    expect((await answer(await event({ t: 'goal', n: 'signup', vid: 'cookievisitor01', sid: 'cookiesession01' }))).text).toBe('');
    await setSite({ remember_visitors: 0 });
  });

  it('asks Pro for a recorded visit and passes its settings on as cfg.rec', async () => {
    await setSite({ record_visits: 1 });
    const res = JSON.parse((await answer(await event({ t: 'pageview', vid: 'recvisitor0001', sid: 'recsession0001' }))).text);
    expect(res).toEqual({ cfg: { rec: REC } });
    expect(decisions).toEqual([{ siteId: site.id, sid: 'recsession0001' }]);
    // Pro says no, or fails: no rec, and the event is stored anyway.
    decide = async () => null;
    expect((await answer(await event({ t: 'pageview', vid: 'recvisitor0001', sid: 'recsession0001' }))).text).toBe('');
    decide = async () => {
      throw new Error('down');
    };
    expect((await event({ t: 'pageview', vid: 'recvisitor0001', sid: 'recsession0001' })).status).toBe(202);
    const views = await w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND session_id = 'recsession0001' AND type = 'pageview'").bind(site.id).first<{ n: number }>();
    expect(views?.n).toBe(3);
    decide = async (_e, s, sid) => (decisions.push({ siteId: s.id, sid }), REC);
  });

  it('records nothing without the bucket binding or without Pro', async () => {
    const bare = await startWorker();
    try {
      const s = await bare.createSite({ domain: 'nobucket.example', record_visits: 1 });
      expect((await bare.admin(`/api/sites/${s.id}`)).body.replay_bucket).toBe(false);
      const r = await bare.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA, cookie: '' },
        body: JSON.stringify({ w: s.id, t: 'pageview', u: 'https://nobucket.example/', vid: 'nobucketvisit1', sid: 'nobucketsess01' }),
      });
      expect(await r.text()).toBe('');
      expect(decisions).toEqual([]);
    } finally {
      await bare.dispose();
    }
    installPro(null);
    try {
      expect((await answer(await event({ t: 'pageview', vid: 'recvisitor0001', sid: 'recsession0001' }))).text).toBe('');
    } finally {
      installPro(fake);
    }
  });

  it('stores a page activity row on the ping, with the visit\'s visitor, and only for a site that records', async () => {
    await event({ t: 'pageview', vid: 'actvisitor0001', sid: 'actsession0001' });
    w.takeRowsWritten();
    const activity = { p: '/pricing', s: 1_767_225_600_000, c: [{ t: 1200, l: 'Start trial', k: 'button' }, { t: 4000, l: 'Buy', k: 'button', n: 4, r: 1 }], e: [{ t: 4100, m: 'TypeError: x', s: 'https://people.example/app.js:12' }] };
    // The SPA moved on before the page was left: the row keeps the activity's own path.
    expect((await event({ t: 'ping', d: 5000, vid: 'actvisitor0001', sid: 'actsession0001', u: 'https://people.example/checkout', a: activity })).status).toBe(202);
    // The ping's 1, and the events row with its 2 index entries and the id counter: 4.
    expect(w.takeRowsWritten()).toBe(5);
    const row = await w.db.prepare("SELECT * FROM events WHERE site_id = ? AND type = 'activity' AND session_id = 'actsession0001'").bind(site.id).first<any>();
    expect(row).toMatchObject({ visitor_id: 'actvisitor0001', path: '/pricing', name: null, datacenter: 0 });
    expect(JSON.parse(row.props)).toEqual({ s: activity.s, c: activity.c, e: activity.e });
    // A ping without activity, or with an empty one, writes the ping alone.
    await event({ t: 'ping', d: 5000, vid: 'actvisitor0001', sid: 'actsession0001', a: { p: '/x', c: [] } });
    expect(w.takeRowsWritten()).toBe(1);
    // A visit the server never saw gets no row.
    await event({ t: 'ping', d: 5000, vid: 'ghostvisitor01', sid: 'ghostsession01', a: activity });
    expect((await w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'ghostsession01'").first<{ n: number }>())?.n).toBe(0);
    // Record visits off: dropped.
    await setSite({ record_visits: 0 });
    await event({ t: 'ping', d: 5000, vid: 'actvisitor0001', sid: 'actsession0001', a: activity });
    expect((await w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'activity' AND session_id = 'actsession0001'").first<{ n: number }>())?.n).toBe(1);
    await setSite({ record_visits: 1 });
  });

  it('activity rows change no number: overview, pages, goals, funnel, profile counts and the goal picker', async () => {
    const s = await w.createSite({ domain: 'counts.example', record_visits: 1 });
    const send = (body: Record<string, unknown>) =>
      w.fetch('/api/event', { method: 'POST', headers: { 'user-agent': UA, cookie: '' }, body: JSON.stringify({ w: s.id, u: 'https://counts.example/pricing', vid: 'countvisitor01', sid: 'countsession01', ...body }) });
    await send({ t: 'pageview' });
    await send({ t: 'goal', n: 'signup' });
    await send({ t: 'outbound', n: 'https://elsewhere.example/' });
    const reads = async () => {
      const q = '?period=24h';
      const [overview, pages, goals, exits, goal] = await Promise.all([
        w.admin(`/api/sites/${s.id}/overview${q}`),
        w.admin(`/api/sites/${s.id}/breakdown${q}&dim=page`),
        w.admin(`/api/sites/${s.id}/breakdown${q}&dim=goal`),
        w.admin(`/api/sites/${s.id}/breakdown${q}&dim=exit_link`),
        w.admin(`/api/sites/${s.id}/goal`),
      ]);
      for (const r of [overview, pages, goals, exits, goal]) expect(r.status).toBe(200);
      const strip = (b: any) => JSON.parse(JSON.stringify(b, (k, v) => (k === 'generated_at' || k === 'cached_at' || k === 'range' ? undefined : v)));
      return [overview, pages, goals, exits, goal].map((r) => strip(r.body));
    };
    const plain = await reads();
    for (let i = 0; i < 3; i++) await send({ t: 'ping', d: 0, a: { p: '/pricing', c: [{ t: i, l: 'Buy', k: 'button' }], e: [{ t: i, m: 'Boom', s: '' }] } });
    const n = await w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND type = 'activity'").bind(s.id).first<{ n: number }>();
    expect(n?.n).toBe(3);
    expect(await reads()).toEqual(plain);
  });

  it('stores identify() traits on the visitor row, merges them, and writes nothing when they did not change', async () => {
    const vid = 'traitvisitor01';
    const sid = 'traitsession01';
    await event({ t: 'pageview', vid, sid });
    w.takeRowsWritten();
    await event({ t: 'identify', vid, sid, p: { user_id: 'u_trait', email: 'trait@acme.example', plan: 'Pro', seats: 3 } });
    const first = w.takeRowsWritten();
    const traits = async () => JSON.parse((await w.db.prepare('SELECT traits FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<{ traits: string }>())!.traits);
    expect(await traits()).toEqual({ plan: 'Pro', seats: '3' });
    // The same call again, and a call without traits: no row.
    await event({ t: 'identify', vid, sid, p: { user_id: 'u_trait', email: 'trait@acme.example', plan: 'Pro', seats: 3 } });
    await event({ t: 'identify', vid, sid, p: { user_id: 'u_trait' } });
    expect(w.takeRowsWritten()).toBe(0);
    // A changed trait is 1 row: the visitor row, as any identify() change.
    await event({ t: 'identify', vid, sid, p: { user_id: 'u_trait', plan: 'Team', company: 'Acme' } });
    expect(w.takeRowsWritten()).toBe(1);
    expect(await traits()).toEqual({ plan: 'Team', seats: '3', company: 'Acme' });
    // Past 20 keys, the call's own traits replace the stored ones.
    const many = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`k${i}`, i]));
    await event({ t: 'identify', vid, sid, p: many });
    expect(await traits()).toEqual(Object.fromEntries(Object.entries(many).map(([k, v]) => [k, String(v)])));
    expect(first).toBeGreaterThan(0);
  });

  it('erases recordings through Pro\'s hook and deletes the replays rows, by visitor and by person', async () => {
    const vid = 'erasevisitor01';
    await event({ t: 'pageview', vid, sid: 'erasesession01' });
    await event({ t: 'identify', vid, sid: 'erasesession01', p: { email: 'erase@acme.example' } });
    await w.db.batch([
      w.db.prepare("INSERT INTO replays (site_id, session_id, visitor_id, started_at, entry_page) VALUES (?, 'erasesession01', ?, ?, '/pricing')").bind(site.id, vid, Date.now()),
      w.db.prepare("INSERT INTO replays (site_id, session_id, visitor_id, started_at, entry_page) VALUES (?, 'othersession01', 'othervisitor01', ?, '/')").bind(site.id, Date.now()),
    ]);
    const res = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'erase@acme.example' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, visitors: 1, recordings: 1 });
    expect(erased.at(-1)).toEqual([vid]);
    const left = await w.db.prepare('SELECT session_id FROM replays WHERE site_id = ?').bind(site.id).all<{ session_id: string }>();
    expect(left.results.map((r) => r.session_id)).toEqual(['othersession01']);
    const log = (await w.admin(`/api/sites/${site.id}/erasures`)).body;
    expect(log[0].counts.recordings).toBe(1);

    // Without Pro, core still deletes the index rows of the erased visitor.
    installPro(null);
    try {
      await event({ t: 'pageview', vid: 'othervisitor01', sid: 'othersession01' });
      const one = await w.admin(`/api/sites/${site.id}/visitors/othervisitor01`, { method: 'DELETE' });
      expect(one.status).toBe(200);
      expect(one.body.recordings).toBeUndefined();
      expect((await w.db.prepare('SELECT COUNT(*) AS n FROM replays WHERE site_id = ?').bind(site.id).first<{ n: number }>())?.n).toBe(0);
    } finally {
      installPro(fake);
    }
  });

  it('deletes the replays rows with the site', async () => {
    const s = await w.createSite({ domain: 'gone.example' });
    await w.db.prepare("INSERT INTO replays (site_id, session_id, visitor_id, started_at) VALUES (?, 'gonesession001', 'gonevisitor001', 1)").bind(s.id).run();
    expect((await w.admin(`/api/sites/${s.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM replays WHERE site_id = ?').bind(s.id).first<{ n: number }>())?.n).toBe(0);
  });

  it('writes 3 rows for a new recording\'s index row, and none for a repeat', async () => {
    const insert = () =>
      w.db.prepare("INSERT OR IGNORE INTO replays (site_id, session_id, visitor_id, started_at, entry_page) VALUES (?, 'costsession001', 'costvisitor001', ?, '/')").bind(site.id, Date.now()).run();
    w.takeRowsWritten();
    await insert();
    expect(w.takeRowsWritten()).toBe(3);
    await insert();
    expect(w.takeRowsWritten()).toBe(0);
  });

  it('reads replays by site and day, and by visitor, through an index', async () => {
    const plan = async (sql: string) => (await w.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(site.id, 1).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');
    expect(await plan('SELECT COUNT(*) FROM replays WHERE site_id = ? AND started_at >= ?')).toMatch(/USING (COVERING )?INDEX idx_replays_started/);
    expect(await plan('SELECT session_id FROM replays WHERE site_id = ? AND visitor_id = ?')).toMatch(/USING (COVERING )?INDEX idx_replays_visitor/);
  });
});
