import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALIAS_DAYS, pruneOldData, RETENTION_DAYS } from '../src/worker/retention';
import { startWorker, type TestWorker } from './helpers/worker';

describe('retention', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());

  it('deletes visits older than 24 months and keeps payments and recent data', async () => {
    const site = await w.createSite();
    const now = Date.now();
    const old = now - (RETENTION_DAYS + 1) * 86_400_000;
    const s = (id: string, vid: string, t: number) =>
      w.db
        .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, 'Direct/None', 'Direct')`)
        .bind(site.id, id, vid, t, t);
    const v = (id: string, t: number) => w.db.prepare('INSERT INTO visitors (site_id, id, first_seen, email) VALUES (?, ?, ?, ?)').bind(site.id, id, t, `${id}@x.y`);
    const e = (sid: string, vid: string, t: number) =>
      w.db.prepare(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES (?, ?, ?, ?, 'pageview', '/')`).bind(site.id, sid, vid, t);
    await w.db.batch([
      v('oldvisitor1', old), s('oldsession1', 'oldvisitor1', old), e('oldsession1', 'oldvisitor1', old),
      v('oldpayer01', old), s('oldsession2', 'oldpayer01', old),
      v('newvisitor1', now), s('newsession1', 'newvisitor1', now), e('newsession1', 'newvisitor1', now),
      w.db.prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id) VALUES ('p1', ?, 'api', ?, 999, 'EUR', 'oldpayer01')`).bind(site.id, old),
    ]);

    expect(await pruneOldData(w.db, now)).toEqual({ events: 1, sessions: 2, visitors: 1, pii: 0, loginFailures: 0 });
    const left = async (sql: string) => (await w.db.prepare(sql).all()).results.map((r: any) => r.id);
    expect(await left('SELECT id FROM visitors ORDER BY id')).toEqual(['newvisitor1', 'oldpayer01']);
    expect(await left('SELECT id FROM sessions')).toEqual(['newsession1']);
    expect(await left('SELECT id FROM payments')).toEqual(['p1']);
  });

  it('deletes app launch aliases after 30 days', async () => {
    const site = await w.createSite();
    const now = Date.now();
    const a = (id: string, t: number) =>
      w.db.prepare('INSERT INTO app_aliases (site_id, id, visitor_id, ts) VALUES (?, ?, ?, ?)').bind(site.id, id, 'visitor0001', t);
    await w.db.batch([a('day_old', now - (ALIAS_DAYS + 1) * 86_400_000), a('day_new', now - (ALIAS_DAYS - 1) * 86_400_000)]);
    await pruneOldData(w.db, now);
    expect((await w.db.prepare('SELECT id FROM app_aliases').all()).results.map((r: any) => r.id)).toEqual(['day_new']);
  });
});
