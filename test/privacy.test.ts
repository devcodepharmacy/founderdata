// Roles, secrets, geo headers, the favicon fetcher, retention, site delete, the erase log and the visitor salt
// (docs/PRIVACY.md, docs/GUIDE.md "Viewer login").
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanIconDomain, findIcon, safeIconUrl } from '../src/worker/favicon';
import { cookielessVisitorId, visitorSecret } from '../src/worker/identity';
import { parseMonths, pruneOldData, retentionOf } from '../src/worker/retention';
import { forgetSite } from '../src/worker/env';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
const DAY = 86_400_000;

describe('privacy: device tokens and the viewer login', () => {
  let w: TestWorker;
  let site: any;
  let token = '';
  let deviceId = '';
  let viewerCookie = '';
  beforeAll(async () => {
    w = await startWorker({ VIEWER_PASSWORD: 'viewer-password' });
    site = await w.createSite({ stripe_webhook_secret: 'whsec_abc123', revenuecat_auth: 'rc-secret-0123456789', lemonsqueezy_secret: 'ls-secret-123', gumroad_seller_id: 'seller1' });
    await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', label: 'Grafana' } });
    await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', name: 'Hook', target: 'https://hooks.example.com/secret-path' } });
    const login = await (await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Phone A' }, headers: { cookie: '' } })).json<any>();
    token = login.token;
    deviceId = login.deviceId;
    await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Phone B' }, headers: { cookie: '' } });
    const res = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '' } });
    expect(await res.json()).toEqual({ ok: true, role: 'viewer' });
    viewerCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    await w.db.batch([
      w.db.prepare("INSERT INTO visitors (site_id, id, first_seen, user_id, name, email) VALUES (?, 'vid-person-1', ?, 'u-42', 'Ada Lovelace', 'ada@example.org')").bind(site.id, Date.now()),
      w.db
        .prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, 'sid-person-1', 'vid-person-1', ?, ?, 'Direct/None', 'Direct')")
        .bind(site.id, Date.now(), Date.now()),
      w.db
        .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id, email, name, customer_id) VALUES ('pay-p1', ?, 'api', ?, 900, 'USD', 'vid-person-1', 'sid-person-1', 'ada@example.org', 'Ada Lovelace', 'cus_1')")
        .bind(site.id, Date.now() - 1000),
    ]);
  });
  afterAll(() => w.dispose());

  const asDevice = (p: string, init: RequestInit = {}) => w.fetch(p, { ...init, headers: { cookie: '', authorization: `Bearer ${token}` } });
  const asViewer = (p: string, init: RequestInit & { json?: unknown } = {}) => w.fetch(p, { ...init, headers: { cookie: viewerCookie } });

  const SECRET_FIELDS = ['api_key', 'stripe_webhook_secret', 'revenuecat_auth', 'lemonsqueezy_secret', 'gumroad_token'];

  it('gives the owner every secret field, masked or plain as before', async () => {
    const own = (await w.admin(`/api/sites/${site.id}`)).body;
    expect(own.api_key).toMatch(/^rt_/);
    expect(own.stripe_webhook_secret).toBe('••••••••');
    expect((await w.admin('/api/auth/me')).body).toEqual({ loggedIn: true, role: 'admin' });
  });

  for (const who of ['device', 'viewer'] as const) {
    (who === 'device' ? itPro : it)(`strips the write key and every secret from site responses for a ${who}`, async () => {
      const call = who === 'device' ? asDevice : asViewer;
      const list = await (await call('/api/sites')).json<any[]>();
      const one = await (await call(`/api/sites/${site.id}`)).json<any>();
      for (const s of [list.find((x) => x.id === site.id), one]) {
        expect(s.name).toBe('Test');
        for (const k of SECRET_FIELDS) expect(s[k], k).toBeNull();
      }
      expect(JSON.stringify(list)).not.toContain('rt_');
    });

    (who === 'device' ? itPro : it)(`refuses share tokens, read keys and alert channels to a ${who}`, async () => {
      const call = who === 'device' ? asDevice : asViewer;
      expect((await call(`/api/sites/${site.id}/share`)).status).toBe(403);
      expect((await call('/api/alerts')).status).toBe(403);
    });
  }

  itPro('lets a phone see and sign out only itself', async () => {
    const devices = await (await asDevice('/api/mobile/devices')).json<any>();
    expect(devices.devices.map((d: any) => d.name)).toEqual(['Phone A']);
    const all = (await w.admin('/api/mobile/devices')).body.devices;
    expect(all).toHaveLength(2);
    const other = all.find((d: any) => d.id !== deviceId).id;
    expect((await asDevice(`/api/mobile/devices/${other}`, { method: 'DELETE' })).status).toBe(403);
    expect((await w.admin('/api/mobile/devices')).body.devices).toHaveLength(2);
    expect((await asViewer(`/api/mobile/devices/${other}`, { method: 'DELETE' })).status).toBe(403);
    expect((await asViewer('/api/mobile/devices')).status).toBe(403);
  });

  it('answers 403 to every write from the viewer login', async () => {
    expect((await w.fetch('/api/auth/me', { headers: { cookie: viewerCookie } }).then((r) => r.json()))).toEqual({ loggedIn: true, role: 'viewer' });
    const writes: [string, string, unknown][] = [
      ['PATCH', `/api/sites/${site.id}`, { name: 'Hacked' }],
      ['POST', `/api/sites/${site.id}/rotate-key`, {}],
      ['DELETE', `/api/sites/${site.id}`, undefined],
      ['POST', `/api/sites/${site.id}/erase`, { email: 'ada@example.org' }],
      ['DELETE', `/api/sites/${site.id}/visitors/vid-person-1`, undefined],
      ['POST', `/api/sites/${site.id}/notes`, { text: 'x', ts: Date.now() }],
      ['POST', `/api/sites/${site.id}/share`, { kind: 'link' }],
      ['POST', '/api/sites', { domain: 'new.example.com' }],
      ['POST', '/api/alerts/channels', { kind: 'webhook', name: 'x', target: 'https://x.example.com' }],
      ['POST', `/api/sites/${site.id}/funnels`, { name: 'f', steps: [] }],
    ];
    for (const [method, p, json] of writes) {
      const res = await w.fetch(p, { method, json, headers: { cookie: viewerCookie } });
      expect(res.status, `${method} ${p}`).toBe(403);
    }
    expect((await w.admin(`/api/sites/${site.id}`)).body.name).toBe('Test');
  });

  it('hides names, emails and user ids from the viewer unless VIEWER_PII is on', async () => {
    const q = '?period=7d';
    const customers = await (await asViewer(`/api/sites/${site.id}/customers${q}`)).json<any[]>();
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ amount: 900, email: null, name: null, pay_email: null, pay_name: null, user_id: null });
    const profile = await (await asViewer(`/api/sites/${site.id}/visitors/vid-person-1`)).json<any>();
    expect(profile.visitor).toMatchObject({ id: 'vid-person-1', email: null, name: null, user_id: null });
    expect(profile.payments[0]).toMatchObject({ email: null, name: null, customer_id: null });
    expect(JSON.stringify(profile)).not.toMatch(/ada|Lovelace|u-42/i);
    expect((await asViewer(`/api/sites/${site.id}/export/payments${q}`)).status).toBe(403);

    w.env.VIEWER_PII = '1';
    try {
      const shown = await (await asViewer(`/api/sites/${site.id}/customers${q}`)).json<any[]>();
      expect(shown[0]).toMatchObject({ email: 'ada@example.org', name: 'Ada Lovelace', user_id: 'u-42' });
      expect((await asViewer(`/api/sites/${site.id}/export/payments${q}`)).status).toBe(200);
    } finally {
      delete w.env.VIEWER_PII;
    }
    // The owner always sees them.
    expect((await w.admin(`/api/sites/${site.id}/customers${q}`)).body[0].email).toBe('ada@example.org');
  });

  itPro('binds each cookie to its own password', async () => {
    // A viewer cookie relabelled as admin does not verify.
    const forged = viewerCookie.replace('rt_auth=viewer.', 'rt_auth=admin.');
    expect(await w.fetch('/api/auth/me', { headers: { cookie: forged } }).then((r) => r.json())).toEqual({ loggedIn: false, role: null });
    w.env.VIEWER_PASSWORD = 'a-new-viewer-password';
    try {
      expect(await w.fetch('/api/auth/me', { headers: { cookie: viewerCookie } }).then((r) => r.json())).toEqual({ loggedIn: false, role: null });
      expect((await asViewer('/api/sites')).status).toBe(401);
      // The owner stays signed in.
      expect((await w.admin('/api/auth/me')).body.role).toBe('admin');
      // The old viewer password no longer signs in; without VIEWER_PASSWORD nobody signs in as viewer.
      const old = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '', 'cf-connecting-ip': '10.9.9.9' } });
      expect(old.status).toBe(401);
    } finally {
      w.env.VIEWER_PASSWORD = 'viewer-password';
    }
    // The viewer password does not sign a phone in.
    const phone = await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '', 'cf-connecting-ip': '10.9.9.8' } });
    expect(phone.status).toBe(401);
  });

  it('logs every erase with counts and no identifier, and lists it for the owner and the viewer', async () => {
    const res = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'ADA@example.org' } });
    expect(res.body).toMatchObject({ ok: true, visitors: 1, sessions: 1, payments: 1 });
    const rows = (await w.db.prepare('SELECT * FROM erasures WHERE site_id = ?').bind(site.id).all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('email');
    expect(JSON.parse(rows[0].counts)).toMatchObject({ visitors: 1, sessions: 1, payments: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/ada|vid-person|u-42/i);

    const list = (await w.admin(`/api/sites/${site.id}/erasures`)).body;
    expect(list).toEqual([{ ts: rows[0].ts, method: 'email', handled_by: 'admin', note: null, counts: JSON.parse(rows[0].counts) }]);
    expect((await asViewer(`/api/sites/${site.id}/erasures`)).status).toBe(200);
    const csv = await (await w.fetch(`/api/sites/${site.id}/erasures?format=csv`)).text();
    expect(csv.split('\r\n')[0]).toBe('time,method,visitors,sessions,events,claims,signals,subscriptions,payments,handled_by,note');
    expect(csv.split('\r\n')[1]).toMatch(/^\d{4}-\d\d-\d\dT.*,email,1,1,0,0,0,0,1,admin,$/);
  });
});

describe('privacy: forwarded geo headers', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite();
  });
  afterAll(() => w.dispose());

  const visit = (ip: string) =>
    w.fetch('/api/event', {
      method: 'POST',
      json: { w: site.id, t: 'pageview', u: `https://${site.domain}/` },
      headers: { 'user-agent': UA, 'cf-connecting-ip': ip, 'x-vercel-ip-country': 'KP', 'x-vercel-ip-city': 'Pyongyang' },
    });

  it('ignores x-vercel-ip-* unless TRUST_FORWARDED_FOR is on', async () => {
    const a = await (await visit('198.51.100.7')).json<any>();
    await w.flush();
    const row = await w.db.prepare('SELECT country, city FROM sessions WHERE site_id = ? AND visitor_id = ?').bind(site.id, a.vid).first<any>();
    expect(row).toEqual({ country: null, city: null });

    w.env.TRUST_FORWARDED_FOR = '1';
    try {
      const b = await (await visit('198.51.100.8')).json<any>();
      await w.flush();
      const trusted = await w.db.prepare('SELECT country, city FROM sessions WHERE site_id = ? AND visitor_id = ?').bind(site.id, b.vid).first<any>();
      expect(trusted).toEqual({ country: 'KP', city: 'Pyongyang' });
    } finally {
      delete w.env.TRUST_FORWARDED_FOR;
    }
  });
});

describe('privacy: favicon fetcher', () => {
  it('rejects IP literals in every spelling, private names and odd ports', () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost/',
      'http://foo.localhost/',
      'http://router.lan/',
      'http://printer.home.arpa/',
      'http://127.0.0.1.nip.io/',
      'https://example.com:8443/',
      'https://user:pw@example.com/',
      'file:///etc/passwd',
    ]) {
      expect(safeIconUrl(bad), bad).toBeNull();
    }
    expect(safeIconUrl('https://acme.example.org/favicon.ico')?.hostname).toBe('acme.example.org');
    expect(safeIconUrl('/icon.png', 'https://shop.acme.dev/')?.toString()).toBe('https://shop.acme.dev/icon.png');
    expect(cleanIconDomain('corp.intranet')).toBeNull();
  });

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  /** A fake web: each URL answers a redirect or an image; requests are recorded. */
  function web(routes: Record<string, string | 'png'>) {
    const seen: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(init?.redirect).toBe('manual');
      const r = routes[url];
      if (r === 'png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      if (r) return new Response(null, { status: 302, headers: { location: r } });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    return { seen, fetchFn };
  }

  it('follows a redirect to a public host', async () => {
    const { seen, fetchFn } = web({ 'https://acme.dev/favicon.ico': 'https://cdn.acme.dev/i.png', 'https://cdn.acme.dev/i.png': 'png' });
    expect((await findIcon('acme.dev', fetchFn))?.type).toBe('image/png');
    expect(seen).toEqual(['https://acme.dev/favicon.ico', 'https://cdn.acme.dev/i.png']);
  });

  it('stops at a redirect to an IP, a private name or a fourth hop', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data', 'http://2130706433/x.png', 'http://[::ffff:10.0.0.1]/', 'http://db.internal/x.png']) {
      const { seen, fetchFn } = web({ 'https://acme.dev/favicon.ico': target, 'https://acme.dev/': target });
      expect(await findIcon('acme.dev', fetchFn), target).toBeNull();
      expect(seen.every((u) => u.startsWith('https://acme.dev/')), target).toBe(true);
    }
    const chain = web({
      'https://acme.dev/favicon.ico': 'https://a.acme.dev/',
      'https://a.acme.dev/': 'https://b.acme.dev/',
      'https://b.acme.dev/': 'https://c.acme.dev/',
      'https://c.acme.dev/': 'https://d.acme.dev/',
      'https://d.acme.dev/': 'png',
    });
    expect(await findIcon('acme.dev', chain.fetchFn)).toBeNull();
    expect(chain.seen).not.toContain('https://d.acme.dev/');
  });

  it('checks the host of an icon link on the home page', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://acme.dev/') return new Response('<link rel="icon" href="http://10.0.0.5/x.png">', { headers: { 'content-type': 'text/html' } });
      if (url.includes('10.0.0.5')) throw new Error('fetched a private address');
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await findIcon('acme.dev', fetchFn)).toBeNull();
  });
});

describe('privacy: retention, site delete and the visitor salt', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());

  it('reads RETENTION_MONTHS and PII_RETENTION_MONTHS', () => {
    expect(retentionOf({})).toEqual({ months: 24, piiMonths: null });
    expect(retentionOf({ RETENTION_MONTHS: '13', PII_RETENTION_MONTHS: '6' })).toEqual({ months: 13, piiMonths: 6 });
    for (const bad of ['', '0', '-3', '2.5', 'keep', '99999']) expect(parseMonths(bad), bad).toBeNull();
  });

  it('prunes visits and claims after RETENTION_MONTHS and clears names and emails after PII_RETENTION_MONTHS', async () => {
    const site = await w.createSite();
    const now = Date.now();
    const at = (months: number) => now - Math.round(months * 30.44 * DAY);
    await w.db.batch([
      w.db.prepare("INSERT INTO visitors (site_id, id, first_seen, user_id, name, email) VALUES (?, 'v-old', ?, 'u1', 'Old Buyer', 'old@example.org')").bind(site.id, at(8)),
      w.db.prepare("INSERT INTO visitors (site_id, id, first_seen, user_id, name, email) VALUES (?, 'v-active', ?, 'u2', 'Still Here', 'here@example.org')").bind(site.id, at(8)),
      w.db.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, 's-old', 'v-old', ?, ?, 'Direct/None', 'Direct')").bind(site.id, at(8), at(8)),
      w.db.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, 's-new', 'v-active', ?, ?, 'Direct/None', 'Direct')").bind(site.id, at(1), at(1)),
      w.db.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, email, name) VALUES ('p-old', ?, 'api', ?, 500, 'USD', 'v-old', 'old@example.org', 'Old Buyer')").bind(site.id, at(8)),
      w.db.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, email, name) VALUES ('p-new', ?, 'api', ?, 500, 'USD', 'new@example.org', 'New Buyer')").bind(site.id, at(1)),
      w.db.prepare("INSERT INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, 'p-old', 'v-old', ?)").bind(site.id, at(8)),
    ]);

    // Visit data is kept 7 months here: the 8-month-old session and claim go, names stay (PII retention off).
    expect(await pruneOldData(w.db, now, { months: 7 })).toMatchObject({ sessions: 1, pii: 0 });
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM payment_claims WHERE site_id = ?').bind(site.id).first('n')).toBe(0);
    expect(await w.db.prepare("SELECT email FROM payments WHERE id = 'p-old'").first('email')).toBe('old@example.org');

    const res = await pruneOldData(w.db, now, { months: 24, piiMonths: 6 });
    expect(res.pii).toBe(2);
    const pays = (await w.db.prepare('SELECT id, email, name FROM payments WHERE site_id = ? ORDER BY id').bind(site.id).all()).results;
    expect(pays).toEqual([
      { id: 'p-new', email: 'new@example.org', name: 'New Buyer' },
      { id: 'p-old', email: null, name: null },
    ]);
    const people = (await w.db.prepare('SELECT id, email, name, user_id FROM visitors WHERE site_id = ? ORDER BY id').bind(site.id).all()).results;
    expect(people).toEqual([
      { id: 'v-active', email: 'here@example.org', name: 'Still Here', user_id: 'u2' },
      { id: 'v-old', email: null, name: null, user_id: null },
    ]);
    // A second run writes nothing.
    expect((await pruneOldData(w.db, now, { months: 24, piiMonths: 6 })).pii).toBe(0);
  });

  it('deletes a site from every table with a site_id column', async () => {
    const site = await w.createSite();
    const keep = await w.createSite();
    const tables = (
      await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'sites'").all<{ name: string }>()
    ).results.map((r) => r.name);
    const withSite: string[] = [];
    for (const t of tables) {
      const cols = (await w.db.prepare(`PRAGMA table_info(${t})`).all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>()).results;
      if (!cols.some((c) => c.name === 'site_id')) continue;
      withSite.push(t);
      // One row for each site, every required column filled with a placeholder.
      for (const id of [site.id, keep.id]) {
        const fill = cols.filter((c) => c.name === 'site_id' || ((c.notnull || c.pk) && c.dflt_value === null && !(c.pk && /INT/i.test(c.type) && cols.filter((x) => x.pk).length === 1)));
        const values = fill.map((c) => (c.name === 'site_id' ? id : /INT|REAL/i.test(c.type) ? 1 : `${t}-${c.name}-${id}`));
        await w.db.prepare(`INSERT INTO ${t} (${fill.map((c) => c.name).join(', ')}) VALUES (${fill.map(() => '?').join(', ')})`).bind(...values).run();
      }
    }
    expect(withSite).toEqual(expect.arrayContaining(['payment_claims', 'stripe_objects', 'subscriptions', 'erasures', 'notes', 'share_tokens']));
    await w.db
      .prepare("INSERT INTO alert_channels (id, kind, name, target, alerts, sites, created_at) VALUES ('ch1', 'webhook', 'x', 'https://x.example.com', '{}', ?, 1)")
      .bind(JSON.stringify([site.id, keep.id]))
      .run();

    expect((await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' })).status).toBe(200);
    forgetSite(site.id);
    for (const t of withSite) {
      // The erase log stays on purpose: it proves requests were answered, and holds no identifier (privacy.ts).
      if (t === 'erasures') {
        expect(await w.db.prepare('SELECT COUNT(*) AS n FROM erasures WHERE site_id = ?').bind(site.id).first('n'), t).toBe(1);
        continue;
      }
      expect(await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`).bind(site.id).first('n'), t).toBe(0);
      expect(await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`).bind(keep.id).first('n'), `${t} of the other site`).toBe(1);
    }
    expect(JSON.parse((await w.db.prepare("SELECT sites FROM alert_channels WHERE id = 'ch1'").first<string>('sites'))!)).toEqual([keep.id]);
    // A mail domain belongs to the deployment: it stays, without the link to the deleted site.
    expect(withSite).toContain('mail_domains');
    expect(await w.db.prepare("SELECT COUNT(*) AS n FROM mail_domains WHERE name = ? AND site_id IS NULL").bind(`mail_domains-name-${site.id}`).first('n')).toBe(1);
    // About 80 statements, one at a time: give a busy machine room.
  }, 60_000);

  it('derives visitor ids from VISITOR_SALT_SECRET when set, and from SESSION_SECRET as before when not', async () => {
    expect(visitorSecret({ SESSION_SECRET: 's1' })).toBe('s1');
    expect(visitorSecret({ SESSION_SECRET: 's1', VISITOR_SALT_SECRET: ' v1 ' })).toBe('v1');

    const site = await w.createSite();
    const send = async () =>
      (
        await (
          await w.fetch('/api/event', {
            method: 'POST',
            json: { w: site.id, t: 'pageview', u: `https://${site.domain}/` },
            headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.9' },
          })
        ).json<any>()
      ).vid;
    const now = Date.now();
    // Unset: the id an existing deployment already gives this visitor today.
    expect(await send()).toBe(await cookielessVisitorId('test-session-secret', site.id, '203.0.113.9', UA, now));

    w.env.VISITOR_SALT_SECRET = 'salt-key-1';
    try {
      const salted = await send();
      expect(salted).toBe(await cookielessVisitorId('salt-key-1', site.id, '203.0.113.9', UA, now));
      // Rotating SESSION_SECRET leaves it alone.
      w.env.SESSION_SECRET = 'rotated-session-secret';
      expect(await send()).toBe(salted);
    } finally {
      delete w.env.VISITOR_SALT_SECRET;
      w.env.SESSION_SECRET = 'test-session-secret';
    }
    await w.flush();
  });
});

describe('privacy: setup --jurisdiction', () => {
  it('reads the flag in both spellings and refuses an unknown jurisdiction', async () => {
    const script = '../scripts/setup.mjs';
    const { readJurisdiction } = await import(/* @vite-ignore */ script);
    expect(readJurisdiction(['--jurisdiction', 'EU'])).toBe('eu');
    expect(readJurisdiction(['--name', 'x', '--jurisdiction=fedramp'])).toBe('fedramp');
    expect(readJurisdiction(['--name', 'x'])).toBeNull();
    expect(() => readJurisdiction(['--jurisdiction', 'mars'])).toThrow(/eu, fedramp/);
  });
});
