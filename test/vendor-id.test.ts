// FounderDataKit's `.vendor` install id mode (ios/README.md, "Storage and consent"): batches carry `ctx.id: "vendor"`
// and the server marks the install persistent, as for consent, so retention and New installs count it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const BUNDLE = 'com.example.vendorid';
let w: TestWorker;
let site: any;

const uid = () => crypto.randomUUID();
const ctx = (over: Record<string, unknown> = {}) => ({
  platform: 'ios', app_version: '1.0.0', build: '1', os_version: '26.1', device: 'iPhone17,1', locale: 'en_US', bundle_id: BUNDLE, ...over,
});
const send = (vid: string, events: unknown[], c: Record<string, unknown>) =>
  w.fetch('/api/app/events', { method: 'POST', body: JSON.stringify({ w: site.id, vid, ctx: c, events }) });
const flag = async (vid: string) =>
  (await w.db.prepare('SELECT persistent FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<{ persistent: number }>())?.persistent;

beforeAll(async () => {
  w = await startWorker();
  site = await w.createSite({ domain: 'vendorid.example', app_bundle_id: BUNDLE, currency: 'EUR' });
});
afterAll(() => w.dispose());

describe('ctx.id "vendor"', () => {
  it('marks the install persistent on its first batch', async () => {
    const vid = uid();
    const res = await send(vid, [{ t: 'session_start', sid: uid() }], ctx({ id: 'vendor' }));
    expect(res.status).toBe(202);
    expect(await flag(vid)).toBe(1);
  });

  it('marks an install seen before without the flag', async () => {
    const vid = uid();
    await send(vid, [{ t: 'session_start', sid: uid() }], ctx());
    expect(await flag(vid)).toBe(0);
    await send(vid, [{ t: 'session_start', sid: uid() }], ctx({ id: 'vendor' }));
    expect(await flag(vid)).toBe(1);
  });

  it('ignores other values and keeps per-launch ids out', async () => {
    const plain = uid(), other = uid(), wrongType = uid();
    await send(plain, [{ t: 'session_start', sid: uid() }], ctx());
    await send(other, [{ t: 'session_start', sid: uid() }], ctx({ id: 'keychain' }));
    await send(wrongType, [{ t: 'session_start', sid: uid() }], ctx({ id: true }));
    expect([await flag(plain), await flag(other), await flag(wrongType)]).toEqual([0, 0, 0]);
  });

  it('costs the same rows as a consented install', async () => {
    const vid = uid(), sid = uid();
    w.takeRowsWritten();
    await send(vid, [{ t: 'session_start', sid }], ctx({ id: 'vendor' }));
    expect(w.takeRowsWritten()).toBe(6);
    await send(vid, [{ t: 'screen', sid, n: 'Home' }], ctx({ id: 'vendor' }));
    expect(w.takeRowsWritten()).toBe(5);
  });

  itPro('counts the install as a returning one in retention', async () => {
    const vid = uid();
    const day = 86_400_000;
    const first = Date.now() - 3 * day;
    await w.db.batch([
      w.db.prepare('INSERT INTO visitors (site_id, id, first_seen, persistent) VALUES (?, ?, ?, 0)').bind(site.id, vid, first),
      w.db
        .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, hostname, source, channel) VALUES (?, ?, ?, ?, ?, ?, 'Direct/None', 'Direct')`)
        .bind(site.id, uid(), vid, first, first + 60_000, `ios:${BUNDLE}`),
    ]);
    // The SDK's next launch, a day and a half later, under the same vendor id.
    await send(vid, [{ t: 'session_start', sid: uid(), ts: first + 1.5 * day }], ctx({ id: 'vendor' }));
    expect(await flag(vid)).toBe(1);
    const { status, body } = await w.admin(`/api/sites/${site.id}/app/retention?period=7d`);
    expect(status).toBe(200);
    const d1 = body.days.find((d: any) => d.day === 1);
    expect(d1).toMatchObject({ eligible: 1, returned: 1 });
  });
});
