import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAdsToken } from '../src/worker/adservices';
import { canonicalId } from '../src/worker/appstore';
import { clampTs, screenPath } from '../src/worker/app';
import { setTrustedRootForTests } from '../src/worker/lib/apple-jws';
import { makeChain, signJws, type TestChain } from './helpers/apple-chain';
import { startWorker, type TestWorker } from './helpers/worker';

const BUNDLE = 'com.example.shipkit';
let w: TestWorker;
let site: any;
let chain: TestChain;
let n = 0;

const uid = () => crypto.randomUUID();
const ctx = (over: Record<string, unknown> = {}) => ({
  platform: 'ios',
  app_version: '1.4.0',
  build: '57',
  os_version: '26.1',
  device: 'iPhone17,1',
  locale: 'en_US',
  bundle_id: BUNDLE,
  ...over,
});
const post = (body: unknown) =>
  w.fetch('/api/app/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const batch = (vid: string, events: unknown[], c = ctx(), siteId = site.id) => post({ w: siteId, ctx: c, vid, events });

const tx = (over: Record<string, unknown> = {}) => {
  const id = String(2_000_000_000 + ++n);
  return {
    transactionId: id,
    originalTransactionId: id,
    bundleId: BUNDLE,
    productId: 'pro_monthly',
    purchaseDate: Date.now(),
    price: 9990,
    currency: 'EUR',
    environment: 'Production',
    type: 'Auto-Renewable Subscription',
    signedDate: Date.now(),
    ...over,
  };
};
const payment = (id: string) => w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<any>();
const session = (id: string) => w.db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<any>();

beforeAll(async () => {
  w = await startWorker();
  site = await w.createSite({ domain: 'example.com', app_bundle_id: BUNDLE, currency: 'EUR' });
  chain = await makeChain();
  setTrustedRootForTests(chain.root.der);
});
afterAll(async () => {
  setTrustedRootForTests(null);
  await w.dispose();
});
afterEach(() => vi.unstubAllGlobals());

describe('helpers', () => {
  it('canonicalises install ids so appAccountToken and vid match', () => {
    expect(canonicalId('E621E1F8C36C495A93FC0C247A3E6E5F')).toBe('e621e1f8-c36c-495a-93fc-0c247a3e6e5f');
    expect(canonicalId('e621e1f8-c36c-495a-93fc-0c247a3e6e5f')).toBe('e621e1f8-c36c-495a-93fc-0c247a3e6e5f');
    expect(canonicalId('install_abc123')).toBe('install_abc123');
  });
  it('clamps client time to the last 72 hours and 5 minutes ahead', () => {
    const now = 1_761_400_000_000;
    expect(clampTs(now - 100 * 3_600_000, now)).toBe(now - 72 * 3_600_000);
    expect(clampTs(now + 3_600_000, now)).toBe(now + 5 * 60_000);
    expect(clampTs('x', now)).toBe(now);
  });
  it('maps screens to paths', () => {
    expect(screenPath('Onboarding/Step2')).toBe('/Onboarding/Step2');
    expect(screenPath('/Settings/')).toBe('/Settings');
  });
});

describe('POST /api/app/events: validation', () => {
  it('rejects bad payloads, unknown sites and other bundles', async () => {
    expect((await post('nope')).status).toBe(400);
    expect((await post({ w: site.id, vid: uid(), events: [] })).status).toBe(400);
    expect((await batch(uid(), Array.from({ length: 51 }, () => ({ t: 'ping', sid: uid(), d: 1 })))).status).toBe(400);
    expect((await batch(uid(), [{ t: 'ping', sid: uid() }], ctx(), 'unknown-site')).status).toBe(404);
    expect((await batch(uid(), [{ t: 'ping', sid: uid() }], ctx({ bundle_id: 'com.other.app' }))).status).toBe(403);
    const big = await batch(uid(), [{ t: 'goal', sid: uid(), n: 'x', p: { pad: 'x'.repeat(70_000) } }]);
    expect(big.status).toBe(413);
  });
  it('refuses app events for a site without a bundle id', async () => {
    const plain = await w.createSite();
    expect((await batch(uid(), [{ t: 'ping', sid: uid() }], ctx(), plain.id)).status).toBe(403);
  });
  it('skips malformed events and reports how many', async () => {
    const res = await batch(uid(), [{ t: 'session_start', sid: uid() }, { t: 'bogus', sid: uid() }, { t: 'screen', sid: 'short' }]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, rejected: 2 });
  });
});

describe('POST /api/app/events: sessions and events', () => {
  it('stores a session with screens, goals, time and identity', async () => {
    const vid = uid().replace(/-/g, '').toUpperCase();
    const sid = uid();
    const t0 = Date.now() - 60_000;
    const res = await batch(vid, [
      { t: 'session_start', sid, ts: t0, src: { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'october' } },
      { t: 'screen', sid, ts: t0 + 1000, n: 'Onboarding/Step1' },
      { t: 'screen', sid, ts: t0 + 2000, n: 'Onboarding/Step2' },
      { t: 'goal', sid, ts: t0 + 3000, n: 'onboarding_complete', p: { variant: 'b' } },
      { t: 'ping', sid, ts: t0 + 30_000, d: 28_000 },
      { t: 'identify', sid, ts: t0 + 40_000, p: { user_id: 'u_1', email: 'Jane@Example.com', name: 'Jane' } },
    ]);
    expect(res.status).toBe(202);
    const s = await session(sid);
    expect(s).toMatchObject({
      visitor_id: canonicalId(vid),
      hostname: `ios:${BUNDLE}`,
      browser: 'App',
      os: 'iOS 26.1',
      device: 'Mobile',
      app_version: '1.4.0 (57)',
      pageviews: 2,
      goals: 1,
      duration: 28_000,
      entry_page: '/Onboarding/Step1',
      exit_page: '/Onboarding/Step2',
      source: 'Newsletter',
      channel: 'Email',
      utm_campaign: 'october',
      started_at: t0,
      last_seen_at: t0 + 40_000,
    });
    const events = (await w.db.prepare('SELECT type, name, path, props, ts FROM events WHERE session_id = ? ORDER BY id').bind(sid).all<any>()).results;
    expect(events).toEqual([
      { type: 'pageview', name: null, path: '/Onboarding/Step1', props: null, ts: t0 + 1000 },
      { type: 'pageview', name: null, path: '/Onboarding/Step2', props: null, ts: t0 + 2000 },
      { type: 'goal', name: 'onboarding_complete', path: '/Onboarding/Step2', props: '{"variant":"b"}', ts: t0 + 3000 },
    ]);
    const v = await w.db.prepare('SELECT * FROM visitors WHERE id = ?').bind(canonicalId(vid)).first<any>();
    expect(v).toMatchObject({ email: 'jane@example.com', user_id: 'u_1', name: 'Jane' });

    // Next batch, same session: a goal before any screen lands on the stored exit screen.
    await batch(vid, [
      { t: 'goal', sid, ts: t0 + 50_000, n: 'paywall_shown' },
      { t: 'screen', sid, ts: t0 + 51_000, n: 'Paywall' },
    ]);
    const s2 = await session(sid);
    expect(s2).toMatchObject({ pageviews: 3, goals: 2, entry_page: '/Onboarding/Step1', exit_page: '/Paywall', last_seen_at: t0 + 51_000 });
    const g = await w.db.prepare("SELECT path FROM events WHERE session_id = ? AND name = 'paywall_shown'").bind(sid).first<any>();
    expect(g.path).toBe('/Onboarding/Step2');
  });

  it('creates a Direct session when session_start never arrived, and detects iPads', async () => {
    const sid = uid();
    await batch(uid(), [{ t: 'screen', sid, n: 'Home' }], ctx({ device: 'iPad16,3' }));
    expect(await session(sid)).toMatchObject({ channel: 'Direct', device: 'Tablet', pageviews: 1, entry_page: '/Home' });
  });
});

describe('Apple Search Ads', () => {
  it('retries once after a 404, gives up on 400', async () => {
    const wait = vi.fn(async () => {});
    const ok = { attribution: true, campaignId: 1 };
    const f1 = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json(ok));
    expect(await resolveAdsToken('tok', f1 as any, wait)).toEqual(ok);
    expect(f1).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5000);
    const [url, init] = f1.mock.calls[0];
    expect(url).toBe('https://api-adservices.apple.com/api/v1/');
    expect(init).toMatchObject({ method: 'POST', body: 'tok', headers: { 'Content-Type': 'text/plain' } });
    const f2 = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    expect(await resolveAdsToken('tok', f2 as any, wait)).toBeNull();
    expect(f2).toHaveBeenCalledTimes(1);
    const f3 = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    expect(await resolveAdsToken('tok', f3 as any, wait)).toBeNull();
    expect(f3).toHaveBeenCalledTimes(2);
  });

  it('marks the session Paid / Apple Search Ads with campaign, keyword and ad group', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, conversionType: 'Download' })),
    );
    const sid = uid();
    await batch(uid(), [{ t: 'session_start', sid, src: { ads_token: 'aaa.bbb.ccc' } }, { t: 'screen', sid, n: 'Home' }]);
    await w.flush();
    expect(await session(sid)).toMatchObject({
      channel: 'Paid',
      source: 'Apple Search Ads',
      utm_campaign: '542370539',
      utm_term: '87675432',
      utm_content: '542317095',
    });
  });

  it('leaves organic installs alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ attribution: false })));
    const sid = uid();
    await batch(uid(), [{ t: 'session_start', sid, src: { ads_token: 'organic' } }]);
    await w.flush();
    expect(await session(sid)).toMatchObject({ channel: 'Direct', source: 'Direct/None' });
  });
});

describe('App Store purchases from the app', () => {
  it('records a verified purchase, credited to the install and session', async () => {
    const vid = uid(), sid = uid();
    const t = tx();
    const res = await batch(vid, [
      { t: 'session_start', sid, src: { ref: 'tiktok-video-3' } },
      { t: 'screen', sid, n: 'Paywall' },
      { t: 'purchase', sid, jws: await signJws(t, chain) },
    ]);
    expect(await res.json()).toEqual({ ok: true, rejected: 0 });
    expect(await payment(`apple_${t.transactionId}`)).toMatchObject({
      provider: 'app_store',
      amount: 999,
      currency: 'EUR',
      kind: 'payment',
      renewal: 0,
      visitor_id: vid,
      session_id: sid,
      matched_by: 'app_event',
      customer_id: `apple:${t.transactionId}`,
    });
    // Sent again from the offline queue: still one payment.
    await batch(vid, [{ t: 'purchase', sid, jws: await signJws(t, chain) }]);
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE id = ?').bind(`apple_${t.transactionId}`).first<any>()).n).toBe(1);

    // A renewal of the same subscription is flagged, so it doesn't count as a new customer.
    const r = tx({ originalTransactionId: t.transactionId, purchaseDate: Date.now() + 1000 });
    await batch(vid, [{ t: 'purchase', sid, jws: await signJws(r, chain) }]);
    expect(await payment(`apple_${r.transactionId}`)).toMatchObject({ renewal: 1, visitor_id: vid });
  });

  it('converts zero-decimal currencies and skips free trials', async () => {
    const vid = uid(), sid = uid();
    const yen = tx({ price: 1_200_000, currency: 'JPY' });
    const trial = tx({ price: 0 });
    const res = await batch(vid, [
      { t: 'session_start', sid },
      { t: 'purchase', sid, jws: await signJws(yen, chain) },
      { t: 'purchase', sid, jws: await signJws(trial, chain) },
    ]);
    expect(((await res.json()) as any).rejected).toBe(0);
    expect((await payment(`apple_${yen.transactionId}`)).amount).toBe(1200);
    expect(await payment(`apple_${trial.transactionId}`)).toBeNull();
  });

  it('rejects forged, foreign and (by default) sandbox purchases', async () => {
    const vid = uid(), sid = uid();
    const other = tx({ bundleId: 'com.other.app' });
    const sandbox = tx({ environment: 'Sandbox' });
    const forged = tx();
    const otherChain = await makeChain();
    const res = await batch(vid, [
      { t: 'session_start', sid },
      { t: 'purchase', sid, jws: await signJws(other, chain) },
      { t: 'purchase', sid, jws: await signJws(sandbox, chain) },
      { t: 'purchase', sid, jws: await signJws(forged, otherChain) },
      { t: 'purchase', sid, jws: 'not.a.jws' },
    ]);
    expect(((await res.json()) as any).rejected).toBe(4);
    for (const t of [other, sandbox, forged]) expect(await payment(`apple_${t.transactionId}`)).toBeNull();
  });

  it('keeps sandbox purchases apart from revenue when the site accepts them', async () => {
    const s2 = await w.createSite({ app_bundle_id: BUNDLE, accept_sandbox: true });
    const vid = uid(), sid = uid();
    const sandbox = tx({ environment: 'Sandbox' });
    await batch(vid, [{ t: 'session_start', sid }, { t: 'purchase', sid, jws: await signJws(sandbox, chain) }], ctx(), s2.id);
    expect((await payment(`apple_${sandbox.transactionId}`)).provider).toBe('app_store_sandbox');
    const o = (await w.admin(`/api/sites/${s2.id}/overview?period=today`)).body;
    expect(o.current.revenue).toBe(0);
  });

  it.each(['rt_vid', 'ml_vid'])('credits the web visit that led to the install (linked_web_vid from src.%s)', async (field) => {
    const webVid = uid(), webSid = uid();
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://example.com/blog/first-post', r: 'https://www.google.com/', vid: webVid, sid: webSid }),
    });
    const vid = uid(), sid = uid();
    const t = tx();
    await batch(vid, [{ t: 'session_start', sid, src: { [field]: webVid } }, { t: 'purchase', sid, jws: await signJws(t, chain) }]);
    const v = await w.db.prepare('SELECT linked_web_vid FROM visitors WHERE id = ?').bind(vid).first<any>();
    expect(v.linked_web_vid).toBe(webVid);
    expect(await payment(`apple_${t.transactionId}`)).toMatchObject({ visitor_id: vid, session_id: webSid });
    const src = (await w.admin(`/api/sites/${site.id}/breakdown?period=today&dim=source`)).body;
    expect(src.find((r: any) => r.label === 'Google')?.revenue).toBeGreaterThanOrEqual(999);
  });
});

describe('POST /api/webhooks/apple/:siteId (App Store Server Notifications V2)', () => {
  const notify = async (type: string, t: Record<string, unknown> | null, over: Record<string, unknown> = {}, c = chain, siteId = site.id) => {
    const payload = {
      notificationType: type,
      notificationUUID: uid(),
      version: '2.0',
      signedDate: Date.now(),
      data: {
        bundleId: BUNDLE,
        environment: 'Production',
        ...(t ? { signedTransactionInfo: await signJws(t, c) } : {}),
        ...over,
      },
    };
    return w.fetch(`/api/webhooks/apple/${siteId}`, { method: 'POST', json: { signedPayload: await signJws(payload, c) } });
  };

  it('links SUBSCRIBED to the install through appAccountToken, flags DID_RENEW, subtracts REFUND', async () => {
    const vid = uid().replace(/-/g, ''), sid = uid();
    await batch(vid, [{ t: 'session_start', sid, src: { utm_source: 'instagram' } }, { t: 'screen', sid, n: 'Paywall' }]);
    const first = tx({ appAccountToken: canonicalId(vid) });
    let res = await notify('SUBSCRIBED', first);
    expect(await res.json()).toEqual({ ok: true, result: 'recorded' });
    expect(await payment(`apple_${first.transactionId}`)).toMatchObject({
      visitor_id: canonicalId(vid),
      session_id: sid,
      matched_by: 'app_account_token',
      renewal: 0,
    });

    // Renewal without appAccountToken: linked through the earlier payment of the same subscription.
    const renew = tx({ originalTransactionId: first.transactionId, purchaseDate: Date.now() + 5000 });
    await notify('DID_RENEW', renew);
    expect(await payment(`apple_${renew.transactionId}`)).toMatchObject({ visitor_id: canonicalId(vid), matched_by: 'customer', renewal: 1 });

    res = await notify('REFUND', { ...renew, revocationDate: Date.now() });
    expect(((await res.json()) as any).result).toBe('recorded');
    expect(await payment(`apple_refund_${renew.transactionId}`)).toMatchObject({ kind: 'refund', amount: -999, session_id: sid });
    // Apple retries: still one refund row.
    expect(((await (await notify('REFUND', { ...renew, revocationDate: Date.now() })).json()) as any).result).toBe('duplicate');
  });

  it('a notification first, then the app event, ends up linked to the session', async () => {
    const vid = uid(), sid = uid();
    const t = tx();
    await notify('ONE_TIME_CHARGE', t);
    expect((await payment(`apple_${t.transactionId}`)).visitor_id).toBeNull();
    await batch(vid, [{ t: 'session_start', sid }, { t: 'purchase', sid, jws: await signJws(t, chain) }]);
    expect(await payment(`apple_${t.transactionId}`)).toMatchObject({ visitor_id: vid, session_id: sid, matched_by: 'app_event' });
  });

  it('accepts a body forwarded unchanged from a product backend (docs/APP-API.md, forward from your backend)', async () => {
    const vid = uid(), sid = uid();
    await batch(vid, [{ t: 'session_start', sid }]);
    const t = tx({ appAccountToken: vid });
    const payload = { notificationType: 'SUBSCRIBED', notificationUUID: uid(), version: '2.0', signedDate: Date.now(), data: { bundleId: BUNDLE, environment: 'Production', signedTransactionInfo: await signJws(t, chain) } };
    // Exactly the bytes Apple sent: compact JSON, as express.raw() hands it to the forwarder.
    const raw = new TextEncoder().encode(JSON.stringify({ signedPayload: await signJws(payload, chain) }));
    const res = await w.fetch(`/api/webhooks/apple/${site.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'node', 'x-forwarded-for': '17.0.0.1' },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'recorded' });
    expect(await payment(`apple_${t.transactionId}`)).toMatchObject({ visitor_id: vid, session_id: sid, matched_by: 'app_account_token' });
    // A forwarder that sends no content type, or a generic one, works too; a second forward is a duplicate.
    const again = await w.fetch(`/api/webhooks/apple/${site.id}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: raw });
    expect(await again.json()).toEqual({ ok: true, result: 'duplicate' });
  });

  it('rejects forged payloads and other apps, ignores what it does not handle', async () => {
    const forged = await makeChain();
    expect((await notify('SUBSCRIBED', tx(), {}, forged)).status).toBe(401);
    expect((await w.fetch(`/api/webhooks/apple/${site.id}`, { method: 'POST', json: {} })).status).toBe(400);
    expect((await notify('SUBSCRIBED', tx(), { bundleId: 'com.other.app' })).status).toBe(400);
    expect(await (await notify('SUBSCRIBED', tx(), { environment: 'Sandbox' })).json()).toEqual({ ok: true, ignored: 'sandbox' });
    expect(await (await notify('TEST', null)).json()).toEqual({ ok: true, ignored: 'TEST' });
    expect((await w.fetch('/api/webhooks/apple/nope', { method: 'POST', json: { signedPayload: 'x' } })).status).toBe(404);
    const t = tx();
    expect(await (await notify('REFUND', t)).json()).toEqual({ ok: true, result: 'no_original' });
  });
});
