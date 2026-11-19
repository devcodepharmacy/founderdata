// Runs the Worker's Hono app in-process against a real local D1 (workerd SQLite via wrangler's
// getPlatformProxy, in memory) with the repo's migrations applied. Counts D1 rows written so tests can
// check the free-plan cost of each write path.
import fs from 'node:fs';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { forgetSite, type Env } from '../../src/worker/env';
import worker, { app } from '../../src/worker/index';
import { dfsFetch } from './dataforseo';
import { inboundMessage, type FakeInboundMessage } from './mail';

const ROOT = path.resolve(__dirname, '../..');

export interface TestWorker {
  db: D1Database;
  /** The bindings and secrets the Worker runs with. */
  env: Env;
  fetch: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  /** Cookie-authenticated dashboard API call; returns parsed JSON. */
  admin: <T = any>(path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; body: T }>;
  /**
   * Hand a raw MIME message to the Worker's email() export, as Email Routing does for one recipient, and wait for its
   * waitUntil work. The answer shows what the handler did: `rejected` (setReject's reason), `forwarded`, `replies`.
   */
  email: (raw: string, envelope: { from: string; to: string }) => Promise<FakeInboundMessage>;
  /** Run the Worker's queue() export on a batch (test/helpers/mail.ts FakeQueue.drain builds them), then wait for waitUntil. */
  queue: (batch: MessageBatch<unknown>) => Promise<void>;
  /** Wait for everything passed to ctx.waitUntil. */
  flush: () => Promise<void>;
  /** D1 rows written since the last call (or since start). */
  takeRowsWritten: () => number;
  createSite: (fields?: Record<string, unknown>) => Promise<any>;
  dispose: () => Promise<void>;
}

type Meta = { rows_written?: number };

function counting(db: D1Database, add: (m: Meta) => void): D1Database {
  const wrap = (inner: D1PreparedStatement): any => ({
    inner,
    bind: (...a: unknown[]) => wrap(inner.bind(...a)),
    first: (col?: string) => (col ? inner.first(col) : inner.first()),
    raw: (o?: any) => inner.raw(o),
    run: async () => {
      const r = await inner.run();
      add(r.meta);
      return r;
    },
    all: async () => {
      const r = await inner.all();
      add(r.meta);
      return r;
    },
  });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => {
      const r = await db.batch(stmts.map((s) => s.inner ?? s));
      for (const x of r) add(x.meta);
      return r;
    },
    exec: (sql: string) => db.exec(sql),
  } as unknown as D1Database;
}

/** ECB rates the tests convert with (units per 1 EUR): 1 EUR = 1.25 USD = 160 JPY = 0.9 CHF. */
export const TEST_RATES: Record<string, number> = { USD: 1.25, JPY: 160, CHF: 0.9 };

/** Every time-series range the rate API mock answered, oldest first. */
export const seriesCalls: string[] = [];

/**
 * Stripe's subscriptions API (the MRR check): a test sets `handler`; without one, Stripe answers an empty list.
 * Every URL the Worker asked for is recorded in `calls`. Nothing leaves the machine.
 */
export const stripeApi: { handler: ((url: URL, init?: RequestInit) => Response | Promise<Response>) | null; calls: string[] } = { handler: null, calls: [] };

// The Frankfurter rate API (src/worker/fx.ts) answers with TEST_RATES; nothing leaves the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  // DataForSEO (pro/worker/dataforseo.ts): a mock, never the real API.
  if (url.startsWith('https://api.dataforseo.com/')) return dfsFetch(url, init);
  if (url.startsWith('https://api.stripe.com/v1/subscriptions')) {
    stripeApi.calls.push(url);
    return stripeApi.handler ? stripeApi.handler(new URL(url), init) : Response.json({ object: 'list', data: [], has_more: false });
  }
  const m = url.match(/^https:\/\/api\.frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return Response.json({ amount: 1, base: 'EUR', date: m[1], rates: TEST_RATES });
  // The time series: TEST_RATES on every weekday, like the ECB.
  const span = url.match(/^https:\/\/api\.frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (span) {
    const rates: Record<string, Record<string, number>> = {};
    for (let t = Date.parse(span[1]); t <= Date.parse(span[2]); t += 86_400_000) {
      if (new Date(t).getUTCDay() % 6) rates[new Date(t).toISOString().slice(0, 10)] = TEST_RATES;
    }
    seriesCalls.push(`${span[1]}..${span[2]}`);
    return Response.json({ amount: 1, base: 'EUR', start_date: span[1], end_date: span[2], rates });
  }
  return realFetch(input, init);
}) as typeof fetch;

export async function startWorker(extraEnv: Partial<Env> = {}): Promise<TestWorker> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(ROOT, 'wrangler.jsonc'),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const raw = proxy.env.DB;
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).sort()) {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await raw.prepare(stmt).run();
  }
  let written = 0;
  const db = counting(raw, (m) => (written += m.rows_written ?? 0));
  const env = {
    DB: db,
    ADMIN_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-session-secret',
    ASSETS: { fetch: async () => new Response('dashboard') },
    ...extraEnv,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} };
  let cookie = '';

  const call = (p: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    // The server groups app launches without a kept id by IP and device per day (src/worker/app.ts, resolveLaunch).
    // Unless a test sets the IP, each install id it sends looks like its own device, so tests stay independent.
    if (p === '/api/app/events' && !headers.has('cf-connecting-ip')) {
      const raw = json !== undefined ? json : typeof rest.body === 'string' ? safeJson(rest.body) : undefined;
      const vid = (raw as { vid?: unknown } | undefined)?.vid;
      if (typeof vid === 'string') headers.set('cf-connecting-ip', `test-device-${vid}`);
    }
    const req = new Request('http://localhost' + p, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
    return Promise.resolve(app.fetch(req, env as any, ctx as any));
  };

  const login = async () => {
    const res = await call('/api/auth/login', { method: 'POST', json: { password: env.ADMIN_PASSWORD } });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  };
  await login();

  const admin = async (p: string, init: { method?: string; json?: unknown } = {}) => {
    const res = await call(p, init);
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  };

  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };

  return {
    db,
    env: env as unknown as Env,
    fetch: call,
    admin,
    email: async (raw, envelope) => {
      const message = inboundMessage(raw, envelope);
      await worker.email(message, env as any, ctx as any);
      await flush();
      return message;
    },
    queue: async (batch) => {
      await worker.queue(batch, env as any, ctx as any);
      await flush();
    },
    flush,
    takeRowsWritten: () => {
      const n = written;
      written = 0;
      return n;
    },
    createSite: async (fields = {}) => {
      const { domain = `site${Math.random().toString(36).slice(2, 8)}.com`, ...rest } = fields as Record<string, unknown>;
      const created = (await admin('/api/sites', { method: 'POST', json: { domain, name: 'Test' } })).body;
      if (!Object.keys(rest).length) return created;
      const patched = await admin(`/api/sites/${created.id}`, { method: 'PATCH', json: rest });
      if (patched.status !== 200) throw new Error(JSON.stringify(patched.body));
      forgetSite(created.id);
      return patched.body;
    },
    dispose: () => proxy.dispose(),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
