// Round 6, build D: ad click ids other than Meta's, first touch, browser language and datacenter traffic
// (migration 0065, src/shared/sources.ts CLICK_NETWORKS, src/worker/datacenter.ts, docs/PRIVACY.md).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classify, clickIdOf } from '../src/shared/sources';
import { languageOf } from '../src/worker/collect';
import { datacenterOf } from '../src/worker/datacenter';
import { buildDigest } from '../src/worker/digest';
import { forgetSite } from '../src/worker/env';
import { app } from '../src/worker/index';
import { liveData } from '../src/worker/live';
import { CLICK_ID_DAYS, pruneClickIds } from '../src/worker/retention';
import { mobileSummary } from '../src/worker/summary';
import { startWorker, type TestWorker } from './helpers/worker';
import { describePro, proModule } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const DAY = 86_400_000;

describe('click ids, unit', () => {
  const q = (s: string) => new URLSearchParams(s);

  it('reads every network and keeps the raw id', () => {
    expect(clickIdOf(q('gclid=Cj0KCQiA-abc_123'))).toEqual({ network: 'google_ads', id: 'Cj0KCQiA-abc_123' });
    expect(clickIdOf(q('gbraid=0AAAAAo_abcdef'))?.network).toBe('google_ads');
    expect(clickIdOf(q('wbraid=ClkKCQiA_abcdef'))?.network).toBe('google_ads');
    expect(clickIdOf(q('msclkid=0f1e2d3c4b5a69788796'))?.network).toBe('microsoft_ads');
    expect(clickIdOf(q('ttclid=E.C.P.abc123'))?.network).toBe('tiktok_ads');
    expect(clickIdOf(q('twclid=2-abcdefgh'))?.network).toBe('x_ads');
    expect(clickIdOf(q('li_fat_id=7c1b9e7a-1111-2222'))?.network).toBe('linkedin_ads');
    expect(clickIdOf(q('rdt_cid=1234567890123'))?.network).toBe('reddit_ads');
    expect(clickIdOf(q('ScCid=abcdef123456'))?.network).toBe('snapchat_ads');
    expect(clickIdOf(q('epik=dj0yJnU9abc'))?.network).toBe('pinterest_ads');
  });

  it('ignores unfilled macros, short values and other parameters', () => {
    expect(clickIdOf(q('gclid={gclid}'))).toBeNull();
    expect(clickIdOf(q('gclid=short'))).toBeNull();
    expect(clickIdOf(q('gclid=' + 'a'.repeat(501)))).toBeNull();
    expect(clickIdOf(q('fbclid=IwAR0abcdefgh&utm_source=x'))).toBeNull();
    // A + the link left unencoded arrives as a space; the stored id has the + back.
    expect(clickIdOf(q('ttclid=E.C.P.ab+cd/ef='))?.id).toBe('E.C.P.ab+cd/ef=');
  });

  it('picks by network order, then parameter order, like the Swift SDK', () => {
    expect(clickIdOf(q('msclkid=bbbbbbbb11&gclid=aaaaaaaa11'))?.network).toBe('google_ads');
    expect(clickIdOf(q('gbraid=bbbbbbbb22&gclid=aaaaaaaa22'))?.id).toBe('aaaaaaaa22');
    expect(clickIdOf(q('gclid={gclid}&msclkid=abcdefgh12'))?.network).toBe('microsoft_ads');
  });

  it('classifies a click as Paid from the network, whatever the referrer or UTMs say', () => {
    expect(classify({ referrerDomain: 'google.com', clickNetwork: 'google_ads' })).toMatchObject({ source: 'Google Ads', channel: 'Paid' });
    expect(classify({ referrerDomain: 'bing.com', utmSource: 'bing', utmMedium: 'cpc', clickNetwork: 'microsoft_ads' })).toMatchObject({ source: 'Microsoft Ads', channel: 'Paid' });
    expect(classify({ referrerDomain: null, clickNetwork: 'tiktok_ads' })).toMatchObject({ source: 'TikTok Ads', channel: 'Paid' });
    // A Meta ad id names the ad, so it wins.
    expect(classify({ referrerDomain: 'facebook.com', metaAd: true, clickNetwork: 'google_ads' }).source).not.toBe('Google Ads');
    // Without a click, google.com stays organic search.
    expect(classify({ referrerDomain: 'google.com' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });

  it('reads the language with the highest weight', () => {
    expect(languageOf('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(languageOf('en;q=0.5, pt-BR;q=0.9')).toBe('pt');
    expect(languageOf('*')).toBeNull();
    expect(languageOf('')).toBeNull();
    expect(languageOf(null)).toBeNull();
    expect(languageOf('x-klingon, 12')).toBeNull();
  });

  it('flags hosting networks unless a proxy forwarded the request', () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(datacenterOf(16509, h({ 'cf-connecting-ip': '3.3.3.3' }))).toBe(1);
    expect(datacenterOf('24940', h({}))).toBe(1);
    // A home ISP.
    expect(datacenterOf(3320, h({}))).toBe(0);
    expect(datacenterOf(undefined, h({}))).toBe(0);
    // The tracker served through the site's own domain on AWS, with TRUST_FORWARDED_FOR on: the visitor's address comes
    // first in X-Forwarded-For.
    expect(datacenterOf(16509, h({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '198.51.100.7, 3.3.3.3' }), true)).toBe(0);
    expect(datacenterOf(16509, h({ 'x-vercel-ip-country': 'DE' }), true)).toBe(0);
  });

  it('ignores forwarded headers a scraper writes itself, unless TRUST_FORWARDED_FOR is on', () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(datacenterOf(16509, h({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '1.2.3.4' }))).toBe(1);
    expect(datacenterOf(16509, h({ 'x-vercel-ip-country': 'DE', 'x-vercel-forwarded-for': '1.2.3.4' }))).toBe(1);
    expect(datacenterOf(16509, h({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '1.2.3.4' }), false)).toBe(1);
  });
});

describe('capture completeness, end to end', () => {
  let w: TestWorker;
  let site: any;
  let ip = 10;

  /** One tracker event. Cookieless unless vid and sid are given; each call without them comes from a new address. */
  const send = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': `198.51.100.${ip++}`, ...headers },
      body: JSON.stringify({ w: site.id, t: 'pageview', ...payload }),
    });
  const session = async (sid: string) => w.db.prepare('SELECT * FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, sid).first<any>();
  const visitor = async (vid: string) => w.db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<any>();
  const lastSession = async () => w.db.prepare('SELECT * FROM sessions WHERE site_id = ? ORDER BY rowid DESC LIMIT 1').bind(site.id).first<any>();
  const breakdown = async (dim: string, extra = '') => (await w.admin(`/api/sites/${site.id}/breakdown?dim=${dim}&period=7d${extra}`)).body as any[];

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shop.example.com' });
  });
  afterAll(() => w.dispose());
  afterEach(() => vi.unstubAllGlobals());

  it('a landing with only ?gclid= from google.com is channel Paid, source Google Ads', async () => {
    await send({ u: 'https://shop.example.com/pricing?gclid=Cj0KCQiA-landing_1', r: 'https://www.google.com/' });
    const s = await lastSession();
    expect(s).toMatchObject({ channel: 'Paid', source: 'Google Ads', click_network: 'google_ads', click_id: 'Cj0KCQiA-landing_1', referrer_domain: 'google.com' });
    expect(s.click_at).toBeGreaterThan(0);
    const rows = await breakdown('source');
    expect(rows.find((r) => r.label === 'Google Ads')?.visitors).toBe(1);
    expect(rows.find((r) => r.label === 'Google')).toBeUndefined();
  });

  it('keeps organic search organic when the macro was never filled', async () => {
    await send({ u: 'https://shop.example.com/?gclid={gclid}', r: 'https://www.google.com/' });
    expect(await lastSession()).toMatchObject({ channel: 'Organic Search', source: 'Google', click_network: null, click_id: null });
  });

  it('turns a direct visit into a paid one when a later page carries the click, keeping the first click', async () => {
    const vid = 'clickvisitor01', sid = 'clicksession01';
    await send({ u: 'https://shop.example.com/', vid, sid });
    expect(await session(sid)).toMatchObject({ channel: 'Direct', click_id: null });
    await send({ u: 'https://shop.example.com/?msclkid=0f1e2d3c4b5a6978', vid, sid });
    expect(await session(sid)).toMatchObject({ channel: 'Paid', source: 'Microsoft Ads', click_network: 'microsoft_ads', click_id: '0f1e2d3c4b5a6978' });
    await send({ u: 'https://shop.example.com/?gclid=secondclick001', vid, sid });
    expect((await session(sid)).click_id).toBe('0f1e2d3c4b5a6978');
    // It was the visitor's first visit, so the first touch moves to the ad too.
    expect(await visitor(vid)).toMatchObject({ first_channel: 'Paid', first_source: 'Microsoft Ads' });
  });

  it("leaves a returning visitor's first touch when a later visit picks up a click", async () => {
    const vid = 'clickvisitor02';
    await send({ u: 'https://shop.example.com/', vid, sid: 'clicksession02' });
    await w.db.prepare('UPDATE visitors SET first_seen = first_seen - ? WHERE site_id = ? AND id = ?').bind(2 * DAY, site.id, vid).run();
    await send({ u: 'https://shop.example.com/', vid, sid: 'clicksession03' });
    await send({ u: 'https://shop.example.com/?ttclid=E.C.P.later', vid, sid: 'clicksession03' });
    expect(await session('clicksession03')).toMatchObject({ channel: 'Paid', source: 'TikTok Ads' });
    expect(await visitor(vid)).toMatchObject({ first_channel: 'Direct', first_source: 'Direct/None' });
  });

  it('filters and breaks down by ad network', async () => {
    const rows = await breakdown('click_network');
    expect(rows.find((r) => r.label === 'google_ads')?.visitors).toBe(1);
    expect(rows.find((r) => r.label === 'microsoft_ads')?.visitors).toBe(1);
    const f = encodeURIComponent(JSON.stringify({ click_network: 'google_ads' }));
    const filtered = await breakdown('channel', `&filters=${f}`);
    expect(filtered).toEqual([expect.objectContaining({ label: 'Paid', visitors: 1 })]);
  });

  it('keeps the first touch when identify creates the visitor row before the first pageview', async () => {
    // Cookieless mode sends identify right after the first pageview, and the two requests can land in either order.
    const vid = 'identifyfirst1';
    await send({ t: 'identify', u: 'https://shop.example.com/launch', vid, sid: 'identifysess01', p: { user_id: 'u_123' } });
    expect(await visitor(vid)).toMatchObject({ first_channel: null });
    await send({ u: 'https://shop.example.com/launch?utm_campaign=spring', r: 'https://www.reddit.com/r/saas', vid, sid: 'identifysess01' });
    expect(await visitor(vid)).toMatchObject({ user_id: 'u_123', first_channel: 'Organic Social', first_source: 'Reddit', first_campaign: 'spring', first_entry_page: '/launch' });
    // A second visit changes nothing.
    await send({ u: 'https://shop.example.com/?gclid=laterclick0001', r: 'https://www.google.com/', vid, sid: 'identifysess02' });
    expect(await visitor(vid)).toMatchObject({ first_source: 'Reddit' });

    // A row made long before (a visitor from before migration 0065) stays empty and falls back to the visit.
    const old = 'identifyold001';
    await w.db.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, old, Date.now() - DAY).run();
    await send({ u: 'https://shop.example.com/', r: 'https://www.reddit.com/', vid: old, sid: 'identifyold002' });
    expect(await visitor(old)).toMatchObject({ first_channel: null, first_source: null });
  });

  it('stores the browser language and breaks down by it', async () => {
    await send({ u: 'https://shop.example.com/de', r: '' }, { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' });
    expect((await lastSession()).language).toBe('de');
    const rows = await breakdown('language');
    expect(rows.find((r) => r.label === 'de')?.visitors).toBe(1);
    const f = encodeURIComponent(JSON.stringify({ language: 'de' }));
    const o = (await w.admin(`/api/sites/${site.id}/overview?period=7d&filters=${f}`)).body;
    expect(o.current.visitors).toBe(1);
  });

  it('stores first touch on the visitor row and answers model=first', async () => {
    const vid = 'firsttouch0001';
    const now = Date.now();
    // Day 1 from Reddit, then a Google Ads click that pays.
    await send({ u: 'https://shop.example.com/blog/post?utm_campaign=launch', r: 'https://www.reddit.com/r/saas', vid, sid: 'ftsession00001' });
    await send({ u: 'https://shop.example.com/pricing?gclid=paidclick00001', r: 'https://www.google.com/', vid, sid: 'ftsession00002' });
    const v = await w.db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<any>();
    expect(v).toMatchObject({ first_source: 'Reddit', first_channel: 'Organic Social', first_campaign: 'launch', first_referrer: 'reddit.com', first_entry_page: '/blog/post' });
    await w.db
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES ('ft_pay', ?, 'api', ?, 4900, 'payment', ?, ?, 'ftsession00002')`)
      .bind(site.id, now, site.currency, vid)
      .run();

    const last = await breakdown('source');
    expect(last.find((r) => r.label === 'Google Ads')).toMatchObject({ revenue: 4900, customers: 1 });
    const first = await breakdown('source', '&model=first');
    expect(first.find((r) => r.label === 'Reddit')).toMatchObject({ revenue: 4900, customers: 1 });
    expect(first.find((r) => r.label === 'Google Ads')?.revenue ?? 0).toBe(0);
    const channels = await breakdown('channel', '&model=first');
    expect(channels.find((r) => r.label === 'Organic Social')?.revenue).toBe(4900);
    const campaigns = await breakdown('campaign', '&model=first');
    expect(campaigns.find((r) => r.label === 'launch')?.revenue).toBe(4900);
    // Dimensions without a first touch answer as before.
    expect(await breakdown('country', '&model=first')).toEqual(await breakdown('country'));
  });

  it('answers model on the read API and the MCP tool', async () => {
    const key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: true } })).body.token as string;
    const auth = { cookie: '', authorization: `Bearer ${key}` };
    const api = await (await w.fetch('/api/v1/stats/breakdown?dim=source&period=7d&model=first', { headers: auth })).json<any>();
    expect(api.model).toBe('first');
    expect(api.rows.find((r: any) => r.value === 'Reddit')?.revenue).toBe(4900);
    const lastApi = await (await w.fetch('/api/v1/stats/breakdown?dim=source&period=7d', { headers: auth })).json<any>();
    expect(lastApi.model).toBe('last');
    expect(lastApi.rows.find((r: any) => r.value === 'Google Ads')?.revenue).toBe(4900);
    const defs = await (await w.fetch('/api/v1/definitions', { headers: auth })).json<any>();
    expect(defs.show_datacenter).toBe(false);
    expect(defs.definitions.datacenter).toMatch(/show_datacenter/);

    const mcp = async (args: Record<string, unknown>) =>
      (
        await (
          await w.fetch('/mcp', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_breakdown', arguments: args } }),
          })
        ).json<any>()
      ).result;
    const viaMcp = await mcp({ dim: 'source', model: 'first', period: '7d' });
    expect(viaMcp.structuredContent.model).toBe('first');
    expect(viaMcp.structuredContent.rows.find((r: any) => r.value === 'Reddit')?.revenue).toBe(4900);
    const byNetwork = await mcp({ dim: 'click_network', period: '7d' });
    expect(byNetwork.structuredContent.rows.map((r: any) => r.value)).toContain('google_ads');
    expect((await mcp({ dim: 'source', model: 'linear' })).isError).toBe(true);
  });

  it('hides datacenter visits by default, and counts them with the per-site toggle', async () => {
    const dc = await w.createSite({ domain: 'dc.example.com' });
    const cfFetch = (asn: number, ipAddr: string, u = 'https://dc.example.com/') => {
      const req = new Request('http://localhost/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA, 'cf-connecting-ip': ipAddr },
        body: JSON.stringify({ w: dc.id, t: 'pageview', u }),
      });
      Object.defineProperty(req, 'cf', { value: { asn } });
      return app.fetch(req, w.env as any, { waitUntil() {}, passThroughOnException() {}, props: {} } as any);
    };
    // One person on a home ISP and two visits from AWS and Hetzner.
    await cfFetch(3320, '198.51.100.200');
    await cfFetch(16509, '3.3.3.3');
    await cfFetch(24940, '5.5.5.5', 'https://dc.example.com/pricing');
    const flags = await w.db.prepare('SELECT datacenter FROM sessions WHERE site_id = ? ORDER BY datacenter').bind(dc.id).all<any>();
    expect(flags.results.map((r) => r.datacenter)).toEqual([0, 1, 1]);
    const events = await w.db.prepare('SELECT SUM(datacenter) AS n FROM events WHERE site_id = ?').bind(dc.id).first<any>();
    expect(events.n).toBe(2);

    const overview = async () => (await w.admin(`/api/sites/${dc.id}/overview?period=7d`)).body;
    const pages = async () => (await w.admin(`/api/sites/${dc.id}/breakdown?dim=page&period=7d`)).body as any[];
    expect((await overview()).current.visitors).toBe(1);
    expect((await pages()).map((r) => r.label)).toEqual(['/']);
    const settings = (await w.admin(`/api/sites/${dc.id}`)).body;
    expect(settings).toMatchObject({ show_datacenter: 0, datacenter_visits: 2 });

    const patched = await w.admin(`/api/sites/${dc.id}`, { method: 'PATCH', json: { show_datacenter: true } });
    expect(patched.status).toBe(200);
    forgetSite(dc.id);
    expect((await w.admin(`/api/sites/${dc.id}`)).body.show_datacenter).toBe(1);
    expect((await overview()).current.visitors).toBe(3);
    expect((await pages()).map((r) => r.label).sort()).toEqual(['/', '/pricing']);
  });

  it('reads click ids and the language from the app SDK', async () => {
    const appSite = await w.createSite({ domain: 'appclick.example.com', app_bundle_id: 'com.example.clicks' });
    const vid = crypto.randomUUID();
    const res = await w.fetch('/api/app/events', {
      method: 'POST',
      json: {
        w: appSite.id,
        vid,
        ctx: { bundle_id: 'com.example.clicks', app_version: '1.0', os_version: '26.0', locale: 'pt_BR' },
        events: [
          { t: 'session_start', sid: 'appclick000001', src: { utm_source: 'google', click_network: 'google_ads', click_id: 'Cj0KCQiA-app_1' } },
          { t: 'session_start', sid: 'appclick000002', src: { click_network: 'myspace_ads', click_id: 'abcdefgh1234' } },
        ],
      },
    });
    expect(res.status).toBe(202);
    const rows = await w.db.prepare('SELECT id, channel, source, click_network, click_id, language FROM sessions WHERE site_id = ? ORDER BY id').bind(appSite.id).all<any>();
    expect(rows.results[0]).toMatchObject({ channel: 'Paid', source: 'Google Ads', click_network: 'google_ads', click_id: 'Cj0KCQiA-app_1', language: 'pt' });
    // An unknown network is ignored, not stored.
    expect(rows.results[1]).toMatchObject({ click_network: null, click_id: null });
    const v = await w.db.prepare('SELECT first_source, first_channel FROM visitors WHERE site_id = ? AND id = ?').bind(appSite.id, vid).first<any>();
    expect(v).toEqual({ first_source: 'Google Ads', first_channel: 'Paid' });
  });

  it('credits an Apple Search Ads install on model=first as well as model=last', async () => {
    const asa = await w.createSite({ domain: 'asa.example.com', app_bundle_id: 'com.example.asa' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ attribution: true, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432 })));
    const vid = crypto.randomUUID(), sid = 'asainstall0001';
    const res = await w.fetch('/api/app/events', {
      method: 'POST',
      json: { w: asa.id, vid, ctx: { bundle_id: 'com.example.asa', app_version: '1.0', os_version: '26.0' }, events: [{ t: 'session_start', sid, src: { ads_token: 'aaa.bbb.ccc' } }] },
    });
    expect(res.status).toBe(202);
    await w.flush();
    const v = await w.db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(asa.id, vid).first<any>();
    expect(v).toMatchObject({ first_channel: 'Paid', first_source: 'Apple Search Ads', first_campaign: '542370539' });
    await w.db
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES ('asa_pay', ?, 'api', ?, 999, 'payment', ?, ?, ?)`)
      .bind(asa.id, Date.now(), asa.currency, vid, sid)
      .run();
    for (const model of ['last', 'first']) {
      const rows = (await w.admin(`/api/sites/${asa.id}/breakdown?dim=source&period=7d&model=${model}`)).body as any[];
      expect(rows.find((r) => r.label === 'Apple Search Ads')).toMatchObject({ revenue: 999, customers: 1 });
      expect(rows.find((r) => r.label === 'Direct/None')).toBeUndefined();
      const channels = (await w.admin(`/api/sites/${asa.id}/breakdown?dim=channel&period=7d&model=${model}`)).body as any[];
      expect(channels.find((r) => r.label === 'Paid')?.revenue).toBe(999);
      const campaigns = (await w.admin(`/api/sites/${asa.id}/breakdown?dim=campaign&period=7d&model=${model}`)).body as any[];
      expect(campaigns.find((r) => r.label === '542370539')?.revenue).toBe(999);
    }
  });

  it('clears raw click ids after 90 days and keeps the network', async () => {
    const now = Date.now();
    const s = (id: string, t: number) =>
      w.db
        .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, click_network, click_id, click_at) VALUES (?, ?, 'oldclickvid1', ?, ?, 'Google Ads', 'Paid', 'google_ads', ?, ?)`)
        .bind(site.id, id, t, t, `gclid_${id}`, t);
    await w.db.batch([s('oldclick000001', now - (CLICK_ID_DAYS + 1) * DAY), s('newclick000001', now - 30 * DAY)]);
    expect(await pruneClickIds(w.db, now)).toBe(1);
    expect(await session('oldclick000001')).toMatchObject({ click_network: 'google_ads', click_id: null, channel: 'Paid' });
    expect((await session('newclick000001')).click_id).toBe('gclid_newclick000001');
    // A second run writes nothing.
    expect(await pruneClickIds(w.db, now)).toBe(0);
  });
});

describePro('datacenter visits stay out of every summary', () => {
  let w: TestWorker;
  let site: any;
  const MIN = 60_000;
  const now = Date.now();
  // Every visit came from a Meta ad, so the Ads tab counts it too.
  const sess = (id: string, started: number, datacenter: number) =>
    w.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page, source, channel, ad_id, country, city, lat, lon, datacenter)
         VALUES (?, ?, ?, ?, ?, 1, 'dcsum.example.com', '/', '/', 'Facebook', 'Paid', '120200000000001', 'DE', 'Berlin', 52.5, 13.4, ?)`,
      )
      .bind(site.id, id, `v_${id}`, started, started + MIN, datacenter);
  const siteRow = async () => w.db.prepare('SELECT * FROM sites WHERE id = ?').bind(site.id).first<any>();

  /** Visitors and online counts for the site on every read the flag applies to. */
  const counts = async (weekFrom: number) => {
    const sites = (await w.admin('/api/sites')).body as any[];
    const listed = sites.find((x) => x.id === site.id);
    const home = (await w.admin('/api/home?period=today')).body;
    const live = await liveData(w.db, 'live-secret', now + 2 * MIN);
    const summary = await mobileSummary(w.db, 'UTC', now + 2 * MIN);
    const digest = await buildDigest(w.db, now, 'UTC');
    const { measure } = await proModule('worker/alert-rules');
    const m = await measure(w.db, await siteRow(), [{ metric: 'visitors', win: '24h' }], now + 3_600_000);
    expect(digest.from).toBe(weekFrom);
    const meta = (await w.admin(`/api/sites/${site.id}/meta?period=today`)).body;
    return {
      metaAds: meta.totals.visits,
      sitesList: [listed.visitors24h, listed.online],
      home: home.sites.find((x: any) => x.id === site.id).current.visitors,
      homeOnline: home.totals.online,
      live: live.sites.find((x) => x.id === site.id)?.online ?? 0,
      livePlaces: (live.places ?? []).reduce((n, p) => n + p.visitors, 0),
      summary: summary.today.visitors,
      digest: digest.sites.find((x) => x.id === site.id)?.visitors,
      alertRule: m.site['24h']!.visitors[0],
    };
  };

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'dcsum.example.com' });
  });
  afterAll(() => w.dispose());

  it('counts 1 of 3 visits by default and all 3 with show_datacenter on', async () => {
    const weekFrom = (await buildDigest(w.db, now, 'UTC')).from;
    // Now: one person and two cloud servers, all online. Last week: the same mix, for the weekly report.
    await w.db.batch([
      sess('person_now', now - MIN, 0),
      sess('cloud_now_1', now - MIN, 1),
      sess('cloud_now_2', now - MIN, 1),
      sess('person_week', weekFrom + 3_600_000, 0),
      sess('cloud_week_1', weekFrom + 3_600_000, 1),
      sess('cloud_week_2', weekFrom + 3_600_000, 1),
    ]);
    expect(await counts(weekFrom)).toEqual({ metaAds: 1, sitesList: [1, 1], home: 1, homeOnline: 1, live: 1, livePlaces: 1, summary: 1, digest: 1, alertRule: 1 });

    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { show_datacenter: true } })).status).toBe(200);
    forgetSite(site.id);
    expect(await counts(weekFrom)).toEqual({ metaAds: 3, sitesList: [3, 3], home: 3, homeOnline: 3, live: 3, livePlaces: 3, summary: 3, digest: 3, alertRule: 3 });
  });
});
