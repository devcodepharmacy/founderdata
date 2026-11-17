// Operations for people with many sites (round 2): the write pool from Worker vars and its total on the home page,
// "payments stopped arriving", webhooks to localhost under wrangler dev, email through Cloudflare Email Routing,
// and the product name in payment alerts and the weekly report.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressOf, deliver, mimeMessage, paymentMessage, readChannel, type ChannelRow } from '../src/worker/alerts';
import { configureBudget, POOL_ID, poolSize, resetBudgetForTests } from '../src/worker/budget';
import { buildDigest, digestMessage, runDailyAlerts, stoppedMessage } from '../src/worker/digest';
import { home } from '../src/worker/home';
import { utcDay } from '../src/worker/identity';
import { daysNeeded, stoppedProviders } from '../src/worker/silence';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

// The Workers runtime's EmailMessage; Node has no cloudflare:email.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: string,
    ) {}
  },
}));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const DAY = 86_400_000;
const HOOK = 'https://hooks.example.com/founderdata';

interface Sent {
  url: string;
  body: any;
}
let sent: Sent[] = [];
const prevFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://hooks.example.com/')) return prevFetch(input, init);
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = prevFetch;
});
beforeEach(() => {
  sent = [];
});

describe('write pool from Worker vars', () => {
  beforeEach(() => resetBudgetForTests(10));

  it('keeps 80,000 and half for one site without vars, and ignores values that are not numbers', () => {
    configureBudget({});
    expect(poolSize()).toBe(80_000);
    configureBudget({ WRITE_POOL_ROWS: 'lots', WRITE_SITE_MAX_SHARE: '2' });
    expect(poolSize()).toBe(80_000);
    configureBudget({ WRITE_POOL_ROWS: '1_000_000' });
    expect(poolSize()).toBe(1_000_000);
    configureBudget({ WRITE_POOL_ROWS: '1,500,000' });
    expect(poolSize()).toBe(1_500_000);
    configureBudget({ WRITE_POOL_ROWS: '-5' });
    expect(poolSize()).toBe(80_000);
  });

  itPro('sizes the pool and the per-site share, and /api/usage reports today against it', async () => {
    const w = await startWorker({ WRITE_POOL_ROWS: '1000', WRITE_SITE_MAX_SHARE: '0.25' } as any);
    try {
      const a = await w.createSite({ domain: 'pool-a.example.com' });
      await w.createSite({ domain: 'pool-b.example.com' });
      const usage = (await w.admin(`/api/sites/${a.id}`)).body.usage;
      expect(usage).toMatchObject({ auto: 1000, cap: 1000, site_max: 250, shared: true });

      // The pool fills at 1,000 rows: the next pageview is dropped and Home's line says so.
      await w.db.prepare('INSERT OR REPLACE INTO site_usage (site_id, day, rows) VALUES (?, ?, ?)').bind(POOL_ID, utcDay(Date.now()), 990).run();
      resetBudgetForTests(10);
      for (let i = 0; i < 3; i++) {
        await w.fetch('/api/event', {
          method: 'POST',
          headers: { 'user-agent': UA, 'cf-connecting-ip': `198.51.100.${i + 1}` },
          body: JSON.stringify({ w: a.id, t: 'pageview', u: 'https://pool-a.example.com/' }),
        });
        await w.flush();
      }
      const now = (await w.admin('/api/usage')).body;
      expect(now.pool.size).toBe(1000);
      expect(now.pool.rows).toBeGreaterThanOrEqual(1000);
      expect(now.pool.capped_at).toEqual(expect.any(Number));
      expect(now.capped[a.id]).toBe(now.pool.capped_at);
    } finally {
      await w.dispose();
    }
  });

  itPro('/api/usage reports zero rows of 80,000 on a quiet day', async () => {
    const w = await startWorker();
    try {
      await w.createSite();
      expect((await w.admin('/api/usage')).body).toEqual({ capped: {}, pool: { rows: 0, size: 80_000, capped_at: null, resets_at: expect.any(Number) } });
    } finally {
      await w.dispose();
    }
  });
});

describe('payments stopped arriving', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());

  const row = (siteId: string, provider: string, ts: number, product: string | null = null) =>
    w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, product) VALUES (?, ?, ?, ?, 2900, 'payment', 'USD', ?)")
      .bind(crypto.randomUUID(), siteId, provider, ts, product);
  const pay = (siteId: string, provider: string, ts: number, product: string | null = null) => row(siteId, provider, ts, product).run();
  /** `n` payments, one every `every` days back from `from`, in one batch. */
  const series = (siteId: string, provider: string, from: number, n: number, every = 1, product: string | null = null) =>
    w.db.batch(Array.from({ length: n }, (_, d) => row(siteId, provider, from - d * every * DAY, product)));

  it('scales the silence it waits for with the usual rate', () => {
    expect(daysNeeded(60)).toBe(3);
    expect(daysNeeded(28)).toBe(5);
    expect(daysNeeded(14)).toBe(10);
    expect(daysNeeded(8)).toBe(18);
  });

  it('flags a provider that went quiet, on Home and in the daily alert, and leaves small and fresh ones alone', async () => {
    const now = Date.parse('2026-11-02T07:00:00Z');
    const shop = await w.createSite({ domain: 'stopped-shop.example.com', name: 'Stopped Shop' });
    const small = await w.createSite({ domain: 'small-shop.example.com', name: 'Small Shop' });
    const live = await w.createSite({ domain: 'live-shop.example.com', name: 'Live Shop' });
    // Stopped Shop: one Stripe payment a day for 28 days, the last one 5 days ago (one a day needs 5 days).
    const last = now - 5 * DAY;
    await series(shop.id, 'stripe', last, 28, 1, 'Pro yearly');
    // Its sandbox purchases never count.
    await series(shop.id, 'app_store_sandbox', now - 10 * DAY, 28);
    // Small Shop: 5 payments, one every 5 days, the last 10 days ago: a small product waits 14 days at least.
    await series(small.id, 'stripe', now - 10 * DAY, 5, 5);
    // Live Shop: daily payments up to yesterday.
    await series(live.id, 'lemonsqueezy', now - DAY, 28);

    const list = await stoppedProviders(w.db, now);
    expect(list).toEqual([expect.objectContaining({ siteId: shop.id, provider: 'stripe', usual: 28, need: 5, days: 5 })]);

    // Home lists it first under "Worth a look".
    const h = await home(w.db, { period: '7d' }, now);
    expect(h.attention.filter((a) => a.kind === 'payments_stopped')).toEqual([
      expect.objectContaining({ siteId: shop.id, link: 'settings', text: expect.stringContaining('Stripe has sent Stopped Shop no payment for 5 days') }),
    ]);
    expect(h.attention[0].kind).toBe('payments_stopped');

    const msg = stoppedMessage(list);
    expect(msg.title).toBe('Payments stopped arriving on Stopped Shop');
    expect(msg.lines[0]).toBe(
      "Stripe has sent Stopped Shop no payment for 5 days. It sent 28 in the 28 days before. Check the webhook endpoint in Stripe and the signing secret in the site's Settings.",
    );

    // The cron sends it on the first day, not on the next, and again a week later.
    const ch = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', target: HOOK, alerts: { daily: false, weekly: false } } });
    expect(ch.body.alerts.payments_stopped).toBe(true);
    expect((await runDailyAlerts(w.env, now)).stopped).toBe(1);
    expect(sent[0].body).toMatchObject({ type: 'payments_stopped', items: [{ site_id: shop.id, provider: 'stripe', days: 5, usual: 28 }] });
    expect((await runDailyAlerts(w.env, now + DAY)).stopped).toBe(0);
    expect((await runDailyAlerts(w.env, now + 7 * DAY)).stopped).toBe(1);

    // A channel that switched it off, or covers other sites only, gets nothing.
    await w.admin(`/api/alerts/channels/${ch.body.id}`, { method: 'PATCH', json: { sites: [live.id] } });
    expect((await runDailyAlerts(w.env, now)).stopped).toBe(0);
    await w.admin(`/api/alerts/channels/${ch.body.id}`, { method: 'PATCH', json: { sites: null, alerts: { payments_stopped: false } } });
    expect((await runDailyAlerts(w.env, now)).stopped).toBe(0);

    // A payment arrives: the provider is no longer stopped. After 60 silent days it is left out too.
    const later = await stoppedProviders(w.db, last + 61 * DAY);
    expect(later.map((x) => `${x.siteName} ${x.provider}`)).toEqual(['Live Shop lemonsqueezy']);
    await pay(shop.id, 'stripe', now - DAY);
    expect(await stoppedProviders(w.db, now)).toEqual([]);
  }, 120_000);
});

describe('webhook channel on localhost', () => {
  it('takes http://localhost and http://127.0.0.1 only under wrangler dev', () => {
    const local = readChannel({ kind: 'webhook', target: 'http://127.0.0.1:9099/hook' }, {}, 0, true);
    expect('error' in local).toBe(false);
    expect('error' in readChannel({ kind: 'webhook', target: 'http://localhost:9099/hook' }, {}, 0, true)).toBe(false);
    const deployed = readChannel({ kind: 'webhook', target: 'http://127.0.0.1:9099/hook' }, {}, 0, false);
    expect(deployed).toEqual({ error: expect.stringMatching(/https:\/\/.*localhost/) });
    // Never plain http to another host, and never for Slack or Discord.
    expect('error' in readChannel({ kind: 'webhook', target: 'http://hooks.example.com/x' }, {}, 0, true)).toBe(true);
    expect('error' in readChannel({ kind: 'slack', target: 'http://localhost/x' }, {}, 0, true)).toBe(true);
  });

  it('the dashboard on localhost accepts it', async () => {
    const w = await startWorker();
    try {
      const res = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'webhook', target: 'http://localhost:9099/hook' } });
      expect(res.status).toBe(200);
      expect(res.body.target).toBe('localhost:9099/••••hook');
    } finally {
      await w.dispose();
    }
  });
});

describe('email through Cloudflare Email Routing', () => {
  const channel: ChannelRow = { id: 'c1', kind: 'email', name: 'Me', target: 'me@example.com', secret: null, alerts: '{}', sites: null, created_at: 0 };

  it('builds a MIME message with both parts, encoded headers and a Message-ID', () => {
    const raw = mimeMessage({
      from: 'FounderData Alerts <alerts@example.com>',
      to: 'me@example.com',
      subject: 'Neue Zahlung: 12,00 € für Café',
      text: 'Grüße\nline 2',
      html: '<p>Grüße</p>',
      now: Date.parse('2026-11-02T07:00:00Z'),
      id: 'abc123',
    });
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('From: "FounderData Alerts" <alerts@example.com>');
    expect(head).toContain('To: me@example.com');
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(head).toContain('Date: Mon, 02 Nov 2026 07:00:00 GMT');
    expect(head).toContain('Message-ID: <abc123@example.com>');
    expect(head).toContain('Content-Type: multipart/alternative; boundary="rt-abc123"');
    expect(raw).not.toMatch(/[^\r]\n/);
    // The encoded subject decodes back to the original.
    const words = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
    expect(words.join('')).toBe('Neue Zahlung: 12,00 € für Café');
    expect(body).toContain('Content-Type: text/plain; charset=UTF-8');
    const parts = raw.split('--rt-abc123');
    expect(parts).toHaveLength(4);
    expect(Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Grüße\nline 2');
    expect(Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('<p>Grüße</p>');
    expect(parts[3]).toBe('--\r\n');
    // A line break in a site name cannot add a header.
    expect(mimeMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'x\r\nBcc: evil@example.com', text: '', html: '' })).not.toContain('\r\nBcc:');
    expect(addressOf('FounderData <alerts@example.com>')).toBe('alerts@example.com');
    expect(addressOf('alerts@example.com')).toBe('alerts@example.com');
  });

  it('sends through the EMAIL binding when there is no Resend key, and reports its error', async () => {
    const send = vi.fn(async (_m: any) => ({ messageId: 'x' }));
    const env = { ALERT_EMAIL_FROM: 'FounderData <alerts@example.com>', EMAIL: { send } } as any;
    const r = await deliver(env, channel, { kind: 'test', title: 'Test from FounderData', lines: ['Hello'] });
    expect(r).toEqual({ ok: true, status: 200 });
    const msg = send.mock.calls[0][0];
    expect(msg).toMatchObject({ from: 'alerts@example.com', to: 'me@example.com' });
    expect(msg.raw).toContain('Subject: Test from FounderData');

    send.mockRejectedValueOnce(new Error('destination address not verified'));
    expect(await deliver(env, channel, { kind: 'test', title: 'T', lines: [] })).toEqual({ ok: false, status: 0, error: 'destination address not verified' });
    // Without a sender, email stays off.
    expect((await deliver({ EMAIL: { send } } as any, channel, { kind: 'test', title: 'T', lines: [] })).error).toMatch(/ALERT_EMAIL_FROM/);
  });

  it('the dashboard API says which way email goes, and Resend wins when both are set', async () => {
    const send = vi.fn(async () => ({}));
    const w = await startWorker({ ALERT_EMAIL_FROM: 'alerts@example.com', EMAIL: { send } } as any);
    try {
      expect((await w.admin('/api/alerts')).body).toMatchObject({ email: true, email_via: 'cloudflare' });
      const ch = (await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'email', target: 'me@example.com' } })).body;
      expect((await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST' })).body.ok).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await w.dispose();
    }
    const both = await startWorker({ ALERT_EMAIL_FROM: 'a@example.com', RESEND_API_KEY: 're_x', EMAIL: { send } } as any);
    try {
      expect((await both.admin('/api/alerts')).body).toMatchObject({ email: true, email_via: 'resend' });
    } finally {
      await both.dispose();
    }
  }, 120_000);

  it('without either, email channels are refused with what to set', async () => {
    const none = await startWorker();
    try {
      expect((await none.admin('/api/alerts')).body).toMatchObject({ email: false, email_via: null });
      const res = await none.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'email', target: 'me@example.com' } });
      expect(res.body.error).toMatch(/RESEND_API_KEY.*send_email binding named EMAIL/);
    } finally {
      await none.dispose();
    }
  }, 60_000);
});

describe('product names', () => {
  const site = { id: 's1', name: 'Habitly', domain: 'habitly.example' } as any;

  it('go in the payment alert title when known', () => {
    const m = paymentMessage(site, { event: 'purchase', id: 'p1', provider: 'app_store', amount: 499, currency: 'USD', product: 'habitly.pro.monthly' } as any, null);
    expect(m.title).toBe('New payment on Habitly: $4.99, habitly.pro.monthly');
    const t = paymentMessage(site, { event: 'trial', id: 'p2', provider: 'app_store', product: 'habitly.pro.yearly' } as any, null);
    expect(t.title).toBe('Trial started on Habitly: habitly.pro.yearly');
    const n = paymentMessage(site, { event: 'purchase', id: 'p3', provider: 'stripe', amount: 2900, currency: 'USD' } as any, null);
    expect(n.title).toBe('New payment on Habitly: $29.00');
  });

  it('the weekly report lists the top 3 products by revenue', async () => {
    const w = await startWorker();
    try {
      const s = await w.createSite({ domain: 'products.example.com', name: 'Products' });
      const monday = Date.parse('2026-11-02T07:00:00Z');
      const add = (product: string | null, amount: number, n: number) =>
        Promise.all(
          Array.from({ length: n }, (_, i) =>
            w.db
              .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, product) VALUES (?, ?, 'stripe', ?, ?, 'payment', 'USD', ?)")
              .bind(crypto.randomUUID(), s.id, monday - 3 * DAY + i * 1000, amount, product)
              .run(),
          ),
        );
      await add('Pro yearly', 9900, 2);
      await add('Pro monthly', 900, 3);
      await add('Stickers', 500, 1);
      await add('Mug', 100, 1);
      await add(null, 5000, 1);
      const d = await buildDigest(w.db, monday);
      expect(d.sites[0].topProducts).toEqual([
        { product: 'Pro yearly', revenue: 19800 },
        { product: 'Pro monthly', revenue: 2700 },
        { product: 'Stickers', revenue: 500 },
      ]);
      const m = digestMessage(d, null);
      expect(m.lines).toContain('Top products: Pro yearly $198.00, Pro monthly $27.00, Stickers $5.00');
      expect(m.html).toContain('Top products: Pro yearly $198.00');
    } finally {
      await w.dispose();
    }
  });
});
