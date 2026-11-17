// App launches without a kept install id (src/worker/app.ts, resolveLaunch; docs/APP-API.md section 3): the SDK makes a
// new id on every launch, and the server groups the launches of one device on one day into one visitor, the way the
// web tracker counts cookieless visitors. A relaunch within 30 minutes continues the session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseVisitors } from '../src/worker/erase';
import { appDayKey } from '../src/worker/identity';
import { setTrustedRootForTests } from '../src/worker/lib/apple-jws';
import { makeChain, signJws } from './helpers/apple-chain';
import { startWorker, type TestWorker } from './helpers/worker';

const BUNDLE = 'com.example.launches';
const UA = 'Shipkit/57 CFNetwork/3826.500 Darwin/25.0.0';
let w: TestWorker;
let site: any;

const uid = () => crypto.randomUUID();
const ctx = (over: Record<string, unknown> = {}) => ({
  platform: 'ios', app_version: '1.0.0', build: '57', os_version: '26.1', device: 'iPhone17,1', locale: 'en_US', bundle_id: BUNDLE, ...over,
});
const send = (vid: string, events: unknown[], { ip = '198.51.100.7', c = ctx() }: { ip?: string; c?: Record<string, unknown> } = {}) =>
  w.fetch('/api/app/events', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, 'user-agent': UA },
    body: JSON.stringify({ w: site.id, vid, ctx: c, events }),
  });
const visitorsOf = async (ids: string[]) =>
  (
    await w.db
      .prepare(`SELECT DISTINCT visitor_id FROM sessions WHERE site_id = ? AND id IN (${ids.map(() => '?').join(', ')})`)
      .bind(site.id, ...ids)
      .all<{ visitor_id: string }>()
  ).results.map((r) => r.visitor_id);
const sessionsOf = async (visitor: string) =>
  (await w.db.prepare('SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at').bind(site.id, visitor).all<any>()).results;

beforeAll(async () => {
  w = await startWorker();
  site = await w.createSite({ domain: 'launches.example', app_bundle_id: BUNDLE, currency: 'EUR' });
});
afterAll(async () => {
  setTrustedRootForTests(null);
  await w.dispose();
});

describe('launches without a kept install id', () => {
  it('counts 20 launches of one device on one day as one visitor', async () => {
    const ip = '198.51.100.20';
    const first = uid();
    const t0 = Date.now() - 3 * 3_600_000;
    const sids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const sid = uid();
      sids.push(sid);
      // One launch every 5 minutes: each one continues the session.
      const ts = t0 + i * 5 * 60_000;
      const res = await send(i ? uid() : first, [{ t: 'session_start', sid, ts }, { t: 'screen', sid, ts, n: 'Home' }], { ip });
      expect(res.status).toBe(202);
    }
    expect(await visitorsOf(sids)).toEqual([first]);
    const sessions = await sessionsOf(first);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: sids[0], pageviews: 20 });

    const overview = (await w.admin(`/api/sites/${site.id}/overview?period=24h`)).body;
    expect(overview.current).toMatchObject({ visitors: 1, sessions: 1 });
  });

  it('continues the session on a relaunch within 30 minutes, and starts one after', async () => {
    const ip = '198.51.100.21';
    const [a, b, c] = [uid(), uid(), uid()];
    const [sa, sb, sc] = [uid(), uid(), uid()];
    const t0 = Date.now() - 2 * 3_600_000;
    await send(a, [{ t: 'session_start', sid: sa, ts: t0 }, { t: 'screen', sid: sa, ts: t0, n: 'Home' }], { ip });
    await send(b, [{ t: 'session_start', sid: sb, ts: t0 + 10 * 60_000 }, { t: 'screen', sid: sb, ts: t0 + 10 * 60_000, n: 'Paywall' }], { ip });
    // A later batch of launch b lands in the same continued session.
    await send(b, [{ t: 'goal', sid: sb, ts: t0 + 11 * 60_000, n: 'paywall_shown' }], { ip });
    await send(c, [{ t: 'session_start', sid: sc, ts: t0 + 90 * 60_000 }, { t: 'screen', sid: sc, ts: t0 + 90 * 60_000, n: 'Home' }], { ip });

    const sessions = await sessionsOf(a);
    expect(sessions.map((s) => s.id)).toEqual([sa, sc]);
    expect(sessions[0]).toMatchObject({ pageviews: 2, goals: 1, entry_page: '/Home', exit_page: '/Paywall', last_seen_at: t0 + 11 * 60_000 });
    const events = (await w.db.prepare('SELECT session_id, visitor_id FROM events WHERE site_id = ? AND visitor_id = ?').bind(site.id, a).all<any>()).results;
    expect(events).toHaveLength(4);
    expect(await w.db.prepare('SELECT 1 FROM visitors WHERE site_id = ? AND id IN (?, ?)').bind(site.id, b, c).first()).toBeNull();
  });

  it('keeps a launch on its visitor when its IP changes', async () => {
    const [a, b] = [uid(), uid()];
    const [sa, sb, sb2] = [uid(), uid(), uid()];
    const t0 = Date.now() - 2 * 3_600_000;
    await send(a, [{ t: 'session_start', sid: sa, ts: t0 }], { ip: '198.51.100.22' });
    await send(b, [{ t: 'session_start', sid: sb, ts: t0 + 60 * 60_000 }], { ip: '198.51.100.22' });
    // Launch b moves from Wi-Fi to cellular, and later starts another session.
    await send(b, [{ t: 'screen', sid: sb, ts: t0 + 61 * 60_000, n: 'Home' }, { t: 'session_start', sid: sb2, ts: t0 + 100 * 60_000 }], { ip: '203.0.113.9' });
    expect(await visitorsOf([sa, sb, sb2])).toEqual([a]);
  });

  it('keeps devices apart: another IP, model or OS version is another visitor', async () => {
    const t0 = Date.now() - 3_600_000;
    const sids = [uid(), uid(), uid(), uid()];
    await send(uid(), [{ t: 'session_start', sid: sids[0], ts: t0 }], { ip: '198.51.100.23' });
    await send(uid(), [{ t: 'session_start', sid: sids[1], ts: t0 }], { ip: '198.51.100.24' });
    await send(uid(), [{ t: 'session_start', sid: sids[2], ts: t0 }], { ip: '198.51.100.23', c: ctx({ device: 'iPhone16,2' }) });
    await send(uid(), [{ t: 'session_start', sid: sids[3], ts: t0 }], { ip: '198.51.100.23', c: ctx({ os_version: '26.2' }) });
    expect(new Set(await visitorsOf(sids)).size).toBe(4);
  });

  it('never groups installs with a kept id (consent or .vendor)', async () => {
    const ip = '198.51.100.25';
    const t0 = Date.now() - 3_600_000;
    const sids = [uid(), uid(), uid(), uid()];
    await send(uid(), [{ t: 'session_start', sid: sids[0], ts: t0 }], { ip, c: ctx({ consent: true }) });
    await send(uid(), [{ t: 'session_start', sid: sids[1], ts: t0 }], { ip, c: ctx({ consent: true }) });
    await send(uid(), [{ t: 'session_start', sid: sids[2], ts: t0 }], { ip, c: ctx({ id: 'vendor' }) });
    await send(uid(), [{ t: 'session_start', sid: sids[3], ts: t0 }], { ip, c: ctx({ id: 'vendor' }) });
    expect(new Set(await visitorsOf(sids)).size).toBe(4);
  });

  it('keeps the visitor when a grouped launch gives consent', async () => {
    const ip = '198.51.100.26';
    const [a, b] = [uid(), uid()];
    const t0 = Date.now() - 2 * 3_600_000;
    await send(a, [{ t: 'session_start', sid: uid(), ts: t0 }], { ip });
    const later = uid();
    await send(b, [{ t: 'session_start', sid: uid(), ts: t0 + 60 * 60_000 }], { ip });
    // setConsent(true) stores launch b's id in the Keychain; its next batches carry ctx.consent.
    await send(b, [{ t: 'session_start', sid: later, ts: t0 + 100 * 60_000 }], { ip: '203.0.113.10', c: ctx({ consent: true }) });
    expect(await visitorsOf([later])).toEqual([a]);
    const v = await w.db.prepare('SELECT persistent FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, a).first<{ persistent: number }>();
    expect(v!.persistent).toBe(1);
  });

  it('credits a purchase from a later launch to the grouped visitor and session', async () => {
    const chain = await makeChain();
    setTrustedRootForTests(chain.root.der);
    const ip = '198.51.100.27';
    const [a, b] = [uid(), uid()];
    const [sa, sb] = [uid(), uid()];
    const t0 = Date.now() - 3_600_000;
    await send(a, [{ t: 'session_start', sid: sa, ts: t0 }], { ip });
    const tx = {
      transactionId: '4100000001', originalTransactionId: '4100000001', bundleId: BUNDLE, productId: 'pro', price: 4990, currency: 'EUR',
      environment: 'Production', purchaseDate: t0 + 5 * 60_000, signedDate: t0 + 5 * 60_000, appAccountToken: b,
    };
    await send(b, [{ t: 'session_start', sid: sb, ts: t0 + 5 * 60_000 }, { t: 'purchase', sid: sb, ts: t0 + 5 * 60_000, jws: await signJws(tx, chain) }], { ip });
    const p = await w.db.prepare('SELECT visitor_id, session_id FROM payments WHERE site_id = ?').bind(site.id).first<any>();
    expect(p).toMatchObject({ visitor_id: a, session_id: sa });
  });

  it('credits a RevenueCat purchase whose attribute is a later launch to the grouped visitor', async () => {
    const rc = await w.createSite({ domain: 'rc-launches.example', app_bundle_id: 'com.example.rclaunches', currency: 'EUR', revenuecat_auth: 'rc-secret-0123456789abcdef' });
    const ip = '198.51.100.28';
    const [a, b] = [uid(), uid()];
    const [sa, sb] = [uid(), uid()];
    const t0 = Date.now() - 3_600_000;
    const c = ctx({ bundle_id: 'com.example.rclaunches' });
    const post = (vid: string, sid: string, ts: number) =>
      w.fetch('/api/app/events', { method: 'POST', headers: { 'cf-connecting-ip': ip, 'user-agent': UA }, body: JSON.stringify({ w: rc.id, vid, ctx: c, events: [{ t: 'session_start', sid, ts }] }) });
    await post(a, sa, t0);
    await post(b, sb, t0 + 5 * 60_000);
    const res = await w.fetch(`/api/webhooks/revenuecat/${rc.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'rc-secret-0123456789abcdef' },
      body: JSON.stringify({
        api_version: '1.0',
        event: {
          id: uid().toUpperCase(), type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:launch', original_app_user_id: '$RCAnonymousID:launch',
          product_id: 'pro_monthly', period_type: 'NORMAL', purchased_at_ms: t0 + 6 * 60_000, event_timestamp_ms: t0 + 6 * 60_000, expiration_at_ms: t0 + 31 * 86_400_000,
          environment: 'PRODUCTION', store: 'APP_STORE', transaction_id: '4200000001', original_transaction_id: '4200000001',
          price: 10.85, price_in_purchased_currency: 9.99, currency: 'EUR',
          subscriber_attributes: { founderDataVisitorId: { value: b, updated_at_ms: t0 } },
        },
      }),
    });
    expect(res.status).toBe(200);
    const p = await w.db.prepare('SELECT visitor_id FROM payments WHERE site_id = ?').bind(rc.id).first<any>();
    expect(p).toMatchObject({ visitor_id: a });
    const sub = await w.db.prepare('SELECT visitor_id FROM subscriptions WHERE site_id = ?').bind(rc.id).first<any>();
    expect(sub).toMatchObject({ visitor_id: a });
  });

  it('erasing the visitor removes the grouped launches', async () => {
    const ip = '198.51.100.28';
    const [a, b] = [uid(), uid()];
    const t0 = Date.now() - 3_600_000;
    await send(a, [{ t: 'session_start', sid: uid(), ts: t0 }], { ip });
    await send(b, [{ t: 'session_start', sid: uid(), ts: t0 + 5 * 60_000 }], { ip });
    const before = await w.db.prepare('SELECT COUNT(*) AS n FROM app_aliases WHERE site_id = ? AND visitor_id = ?').bind(site.id, a).first<{ n: number }>();
    expect(before!.n).toBe(3);
    await eraseVisitors(w.db, site, [a]);
    const after = await w.db.prepare('SELECT COUNT(*) AS n FROM app_aliases WHERE site_id = ? AND visitor_id = ?').bind(site.id, a).first<{ n: number }>();
    expect(after!.n).toBe(0);
    // Launch b's next batch no longer finds the erased visitor through its alias.
    const sid = uid();
    await send(b, [{ t: 'session_start', sid, ts: Date.now() }], { ip });
    expect(await visitorsOf([sid])).not.toEqual([a]);
  });
});

describe('appDayKey', () => {
  const device = { device: 'iPhone17,1', os_version: '26.1', locale: 'en_US' };
  const day = Date.UTC(2026, 10, 3, 12);

  it('is the same all day and changes at 00:00 UTC', async () => {
    const k = await appDayKey('secret', 'site', '198.51.100.1', UA, device, day);
    expect(k).toMatch(/^day_[0-9a-f]{32}$/);
    expect(await appDayKey('secret', 'site', '198.51.100.1', UA, device, day + 11 * 3_600_000)).toBe(k);
    expect(await appDayKey('secret', 'site', '198.51.100.1', UA, device, day + 12 * 3_600_000)).not.toBe(k);
  });

  it('differs per site, IP, user agent, model, OS version and locale', async () => {
    const k = await appDayKey('secret', 'site', '198.51.100.1', UA, device, day);
    const others = await Promise.all([
      appDayKey('secret', 'other', '198.51.100.1', UA, device, day),
      appDayKey('secret', 'site', '198.51.100.2', UA, device, day),
      appDayKey('secret', 'site', '198.51.100.1', 'Shipkit/58 CFNetwork/3826.500 Darwin/25.0.0', device, day),
      appDayKey('secret', 'site', '198.51.100.1', UA, { ...device, device: 'iPhone16,2' }, day),
      appDayKey('secret', 'site', '198.51.100.1', UA, { ...device, os_version: '26.2' }, day),
      appDayKey('secret', 'site', '198.51.100.1', UA, { ...device, locale: 'de_DE' }, day),
    ]);
    expect(new Set([k, ...others]).size).toBe(7);
  });
});
