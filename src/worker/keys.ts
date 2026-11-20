// Scoped API keys (migration 0029, docs/API.md "API keys"): one key per agent or script, with the scopes it needs, the
// sites it may touch and an optional expiry. The secret (fdk_...) is shown once; D1 keeps its SHA-256.
//
// One key in `Authorization: Bearer` does what the old pair did: read routes (share.ts requireReadKey) take it like a
// read key, write routes (writeSiteOf) like the site API key, and MCP passes it to both. The old keys keep working with
// fixed scopes (LEGACY_SCOPES): a read key (rtr_) reads, with revenue if it shows revenue, and the site API key (rt_)
// writes payments, goals, erasures and notes.
//
// Usage per key (last used, last write, calls in the last 24 hours) costs at most 1 row written a minute per key and
// isolate: calls are counted in memory and added to the row on the first call after a minute (noteUse).
import type { Context, Hono, Next } from 'hono';
import { requireAuth, sha256Hex } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { randomId } from './lib/crypto';

export const SCOPES = ['read', 'read:revenue', 'read:rows', 'notes:write', 'alerts:write', 'payments:write', 'seo:write', 'aso:write', 'research:write', 'spend:write', 'spend:ai', 'spend:seo', 'mail:read', 'mail:write', 'mail:templates', 'dashboards:write'] as const;
export type Scope = (typeof SCOPES)[number];
/**
 * Scopes that write. spend:ai and spend:seo also write, and each one lets a key start billed calls on the owner's provider
 * account. spend:write is different: it records what the owner spent on ads elsewhere and bills nothing.
 */
export type WriteScope = Extract<Scope, `${string}:write` | `spend:${string}`>;

/** What each scope allows, for errors and the dashboard. */
export const SCOPE_TEXT: Record<Scope, string> = {
  read: 'read stats, SEO, ASO, app panels and notes, without revenue',
  'read:revenue': 'read revenue, payments, customers and MRR too',
  'read:rows': 'download raw rows (sessions, events, and with read:revenue payments and subscriptions) as CSV, without names or emails',
  'notes:write': 'add chart notes and review them',
  'alerts:write': 'change alert rules',
  'payments:write': 'send and delete payments, goals and erasures',
  'seo:write': 'push the SEO snapshot (Search Console rows and meta) and AI answer checks you ran yourself',
  'aso:write': 'change ASO keywords, countries and competitors, and push ASO snapshots and reviews',
  'research:write': 'add entries to the research log (findings, decisions, data bought) and track keywords',
  'spend:write': 'send ad spend from channels without an import (Google Ads, TikTok, a newsletter), as rows or a CSV. It records spend and costs nothing',
  'spend:ai': 'add prompts and competitors to the AI visibility runner. Each prompt is billed on every engine the owner turned on: 3 checks on its first day, then one every 2 to 7 days (daily if the owner chose that)',
  'spend:seo': "spend the owner's DataForSEO money on keyword research, up to the site's monthly cap",
  'mail:read': "read the deployment's mail: inbox threads, sent messages and their events, with addresses and message text",
  'mail:write': "send mail from the deployment's domains and change the inbox (reply, mark read, archive). It does not include mail:read",
  'mail:templates': "create, change, publish and delete the mail templates of the deployment's domains. It sends nothing",
  'dashboards:write': 'create, change and delete custom dashboards, on the sites the key covers',
};

/** The scopes the old keys have. They can't change. */
export const LEGACY_SCOPES = {
  readKey: ['read'] as Scope[],
  readKeyWithRevenue: ['read', 'read:revenue'] as Scope[],
  siteKey: ['payments:write', 'notes:write', 'alerts:write'] as Scope[],
};

export const KEY_PREFIX = 'fdk_';
/** Keys a deployment can have. */
export const MAX_KEYS = 50;
/** Seconds an isolate trusts a key it looked up, so a revoked key can answer elsewhere for up to a minute. */
const KEY_TTL = 60;
/** Usage is written at most this often per key and isolate. */
export const USAGE_EVERY_MS = 60_000;
const HOUR = 3_600_000;

export interface ApiKeyRow {
  hash: string;
  id: string;
  name: string;
  hint: string;
  scopes: string;
  sites: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_write_at: number | null;
  hours: string;
}

/** A live key, parsed. */
export interface ApiKey {
  hash: string;
  id: string;
  name: string;
  scopes: Scope[];
  /** Site ids, or null for every site. */
  sites: string[] | null;
  expires_at: number | null;
}

const parse = (r: ApiKeyRow): ApiKey => ({
  hash: r.hash,
  id: r.id,
  name: r.name,
  scopes: (JSON.parse(r.scopes) as string[]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
  sites: r.sites ? (JSON.parse(r.sites) as string[]) : null,
  expires_at: r.expires_at,
});

/** read:revenue includes read. */
export const canRead = (scopes: readonly string[]) => scopes.includes('read') || scopes.includes('read:revenue');

// ---------- lookup, cached per isolate for a minute

const keyCache = new Map<string, { key: ApiKey | null; at: number }>();
/** Requests already counted, so a route that looks the key up twice counts once. */
const counted = new WeakSet<Request>();

/** The fdk_ secret in `Authorization: Bearer`, or null. */
export function bearerSecret(c: Context<AppEnv>): string | null {
  const m = /^Bearer\s+(fdk_[a-z0-9]{16,64})$/i.exec(c.req.header('authorization')?.trim() ?? '');
  return m ? m[1] : null;
}

/**
 * The live scoped key in the request's Authorization header, or null (none, unknown, expired or revoked). Counts the
 * call toward the key's usage unless `count` is false; `write` marks it as a write.
 */
export async function scopedKeyOf(c: Context<AppEnv>, opts: { count?: boolean; write?: boolean } = {}): Promise<ApiKey | null> {
  const secret = bearerSecret(c);
  if (!secret) return null;
  const hash = await sha256Hex(secret);
  const hit = keyCache.get(hash);
  let key = hit && Date.now() - hit.at < KEY_TTL * 1000 ? hit.key : undefined;
  if (key === undefined) {
    const row = await c.env.DB.prepare('SELECT * FROM api_keys WHERE hash = ?').bind(hash).first<ApiKeyRow>();
    key = row ? parse(row) : null;
    keyCache.set(hash, { key, at: Date.now() });
  }
  if (!key || (key.expires_at && key.expires_at <= Date.now())) return null;
  if (opts.count !== false) noteUse(c, key, !!opts.write);
  return key;
}

/** Whether the key may touch `siteId`. */
export const coversSite = (key: Pick<ApiKey, 'sites'>, siteId: string) => !key.sites || key.sites.includes(siteId);

// ---------- usage: at most one write a minute per key and isolate

const usage = new Map<string, { n: number; since: number; used: number; write: number | null; flushedAt: number }>();

/**
 * Adds the pending calls to the key's row: last_used_at, last_write_at and the hour slot of the first pending call.
 * Exported for tests.
 */
export function usageStatement(db: D1Database, hash: string, p: { n: number; since: number; used: number; write: number | null }) {
  const hour = Math.floor(p.since / HOUR);
  const slot = hour % 24;
  return db
    .prepare(
      `UPDATE api_keys SET
         last_used_at = MAX(COALESCE(last_used_at, 0), ?2),
         last_write_at = CASE WHEN ?3 IS NULL THEN last_write_at ELSE MAX(COALESCE(last_write_at, 0), ?3) END,
         hours = json_set(hours, ?4, json_array(?5, CASE WHEN json_extract(hours, ?6) = ?5 THEN json_extract(hours, ?7) ELSE 0 END + ?8))
       WHERE hash = ?1`,
    )
    .bind(hash, p.used, p.write, `$[${slot}]`, hour, `$[${slot}][0]`, `$[${slot}][1]`, p.n);
}

function noteUse(c: Context<AppEnv>, key: ApiKey, write: boolean) {
  if (counted.has(c.req.raw) && !write) return;
  counted.add(c.req.raw);
  const now = Date.now();
  let p = usage.get(key.hash);
  if (!p) usage.set(key.hash, (p = { n: 0, since: now, used: now, write: null, flushedAt: 0 }));
  if (!p.n) p.since = now;
  p.n++;
  p.used = now;
  if (write) p.write = now;
  if (now - p.flushedAt < USAGE_EVERY_MS) return;
  const stmt = usageStatement(c.env.DB, key.hash, p);
  Object.assign(p, { n: 0, write: null, flushedAt: now });
  const run = stmt.run().catch(() => undefined);
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // No execution context (a script or a test without one): the statement runs on its own.
  }
}

/** Forget one cached key (a revoked teammate's keys). */
export function forgetApiKey(hash: string) {
  keyCache.delete(hash);
}

/** Tests only: forget cached keys and pending usage. */
export function resetKeysForTests() {
  keyCache.clear();
  usage.clear();
}

/** Calls in the 24 hours before `now`, from the hours column. */
export function callsIn24h(hours: string, now = Date.now()): number {
  const current = Math.floor(now / HOUR);
  try {
    return (JSON.parse(hours) as [number, number][]).reduce((n, [h, k]) => (h > current - 24 && h <= current ? n + k : n), 0);
  } catch {
    return 0;
  }
}

// ---------- write routes

export type WriteAuth = { site: Site; key: ApiKey | null } | { error: string; status: 400 | 401 | 403 | 404 };

const WRITE_TEXT: Record<WriteScope, string> = {
  'notes:write': 'write notes',
  'alerts:write': 'change alerts',
  'payments:write': 'send payments, goals or erasures',
  'seo:write': 'push the SEO snapshot',
  'aso:write': 'change ASO settings or push ASO data',
  'research:write': 'add to the research log or track keywords',
  'spend:write': 'send ad spend',
  'spend:ai': 'add AI visibility prompts, which cost money on every enabled engine',
  'spend:seo': "spend DataForSEO money on keyword research",
  'mail:write': 'send mail',
  'dashboards:write': 'change dashboards',
};

/**
 * The site a write route acts on, from the key in `Authorization: Bearer`:
 * - a scoped key (fdk_) with `scope`, for its one site, or for `?site=<id>` when it covers more than one;
 * - the site's API key (rt_...), which has payments:write and notes:write.
 * A missing or unknown key gets 401, a key without the scope 403.
 */
export async function writeSiteOf(c: Context<AppEnv>, scope: WriteScope): Promise<WriteAuth> {
  const auth = c.req.header('authorization')?.trim() ?? '';
  if (bearerSecret(c)) {
    const key = await scopedKeyOf(c, { write: true });
    if (!key) return { error: 'This API key does not exist, expired or was revoked.', status: 401 };
    if (!key.scopes.includes(scope)) {
      return {
        error: `This key can't ${WRITE_TEXT[scope]}: it needs the ${scope} scope. Create a key with it in Settings, Agents. Its scopes: ${key.scopes.join(', ')}.`,
        status: 403,
      };
    }
    let siteId = key.sites?.length === 1 ? key.sites[0] : c.req.query('site');
    if (!siteId) return { error: 'This key covers more than one site. Add ?site=<site id>; GET /api/v1/whoami lists the sites it covers.', status: 400 };
    if (!coversSite(key, siteId)) return { error: `This key does not cover the site ${siteId}.`, status: 403 };
    const site = await getSite(c.env.DB, siteId);
    if (!site) return { error: `No site has the id ${siteId}.`, status: 404 };
    return { site, key };
  }
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  const site = secret ? await c.env.DB.prepare('SELECT * FROM sites WHERE api_key = ?').bind(secret).first<Site>() : null;
  if (!site) return { error: 'invalid api key', status: 401 };
  if (!LEGACY_SCOPES.siteKey.includes(scope)) {
    return { error: `The site API key can't ${WRITE_TEXT[scope]}. Create a key with the ${scope} scope in Settings, Agents.`, status: 403 };
  }
  return { site, key: null };
}

/** Middleware form of writeSiteOf: sets `site` or answers the error. */
export const requireWriteKey = (scope: WriteScope) => async (c: Context<AppEnv>, next: Next) => {
  const auth = await writeSiteOf(c, scope);
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  c.set('site', auth.site);
  // The scoped key, for a route that asks what else it may do (erase.ts mayEraseMail). Unset for a site's own key.
  if (auth.key) (c as unknown as Context<{ Variables: { apiKey: ApiKey } }>).set('apiKey', auth.key);
  await next();
};

// ---------- routes of the whole deployment (mail)

/** Scopes of routes that belong to the deployment, not to a site. */
export type AccountScope = Extract<Scope, 'mail:read' | 'mail:write' | 'mail:templates'>;

export type AccountAuth = { key: ApiKey } | { error: string; status: 401 | 403 };

const ACCOUNT_TEXT: Record<AccountScope, string> = {
  'mail:read': 'read mail',
  'mail:write': 'send mail',
  'mail:templates': 'change mail templates',
};

/**
 * The scoped key (fdk_) in `Authorization: Bearer` for a route of the whole deployment, such as FounderData Pro's mail.
 * The key needs exactly `scope`: `read` and the other scopes never reach mail, and mail:write does not include
 * mail:read, so an app that sends cannot read the inbox. The sites a key covers do not matter here. Old keys (rt_, rtr_)
 * get 401: they belong to one site.
 * 401: no key, or an unknown, expired or revoked one. 403: the key lacks the scope.
 */
export async function accountKeyOf(c: Context<AppEnv>, scope: AccountScope): Promise<AccountAuth> {
  if (!bearerSecret(c)) return { error: 'Send a FounderData API key (fdk_...) in Authorization: Bearer. Create one in Settings, Agents.', status: 401 };
  const key = await scopedKeyOf(c, { write: c.req.method !== 'GET' && c.req.method !== 'HEAD' });
  if (!key) return { error: 'This API key does not exist, expired or was revoked.', status: 401 };
  if (!key.scopes.includes(scope)) {
    return {
      error: `This key can't ${ACCOUNT_TEXT[scope]}: it needs the ${scope} scope. Create a key with it in Settings, Agents. Its scopes: ${key.scopes.join(', ')}.`,
      status: 403,
    };
  }
  return { key };
}

// ---------- the SEO and ASO routes of the dashboard, for a key with seo:write or aso:write

/**
 * Dashboard routes a scoped key may call, with the scope each needs. Scripts that push the SEO snapshot or run the
 * ASO collector use the same paths with the admin login or with a key, so switching to a key changes one header.
 * GET of the SEO snapshot is here so a script can merge `meta` before it writes it back.
 */
export const KEY_ROUTES: { method: string; path: RegExp; scope: Extract<WriteScope, 'seo:write' | 'aso:write'> }[] = [
  { method: 'GET', path: /^\/api\/sites\/([^/]+)\/seo$/, scope: 'seo:write' },
  { method: 'PUT', path: /^\/api\/sites\/([^/]+)\/seo\/[^/]+$/, scope: 'seo:write' },
  { method: 'GET', path: /^\/api\/aso\/collect$/, scope: 'aso:write' },
  { method: 'POST', path: /^\/api\/sites\/([^/]+)\/aso\/keywords$/, scope: 'aso:write' },
  { method: 'DELETE', path: /^\/api\/sites\/([^/]+)\/aso\/keywords$/, scope: 'aso:write' },
  { method: 'PUT', path: /^\/api\/sites\/([^/]+)\/aso\/settings$/, scope: 'aso:write' },
  { method: 'POST', path: /^\/api\/sites\/([^/]+)\/aso\/snapshot$/, scope: 'aso:write' },
  { method: 'POST', path: /^\/api\/sites\/([^/]+)\/aso\/reviews$/, scope: 'aso:write' },
];

/** The key a request on a KEY_ROUTES route came with; unset for the login. */
export const apiKeyOf = (c: Context<AppEnv>): ApiKey | undefined => (c as unknown as Context<{ Variables: { apiKey?: ApiKey } }>).get('apiKey');

/**
 * Middleware for /api/sites/* and /api/aso/*: a scoped key (fdk_) in `Authorization: Bearer` may call the KEY_ROUTES
 * with their scope, for the sites it covers. Anything else, the login or a phone, goes on to requireAuth.
 * 401: unknown, expired or revoked key. 403: a route keys can't use, a missing scope or a site the key does not cover.
 */
export const keyOrLogin = async (c: Context<AppEnv>, next: Next) => {
  if (!bearerSecret(c)) return requireAuth(c, next);
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  const path = c.req.path;
  const route = KEY_ROUTES.find((r) => r.method === method && r.path.test(path));
  const key = await scopedKeyOf(c, { write: method !== 'GET' });
  if (!key) return c.json({ error: 'This API key does not exist, expired or was revoked. Create a new one in Settings, Agents.' }, 401);
  if (!route) {
    return c.json(
      {
        error:
          'API keys can\'t call this dashboard route. Keys read through /api/v1 and /mcp, and write the SEO snapshot ' +
          '(seo:write) and ASO data (aso:write) on the routes docs/API.md lists. Everything else needs the admin login.',
      },
      403,
    );
  }
  if (!key.scopes.includes(route.scope)) {
    return c.json(
      { error: `This key can't ${WRITE_TEXT[route.scope]}: it needs the ${route.scope} scope. Its scopes: ${key.scopes.join(', ')}. Create a key with ${route.scope} in Settings, Agents.` },
      403,
    );
  }
  const siteId = route.path.exec(path)?.[1];
  if (siteId && !coversSite(key, decodeURIComponent(siteId))) {
    return c.json({ error: `This key does not cover the site ${decodeURIComponent(siteId)}. GET /api/v1/whoami lists the sites it covers.` }, 403);
  }
  (c as unknown as Context<{ Variables: { apiKey: ApiKey } }>).set('apiKey', key);
  await next();
};

// ---------- managing keys: admin session only

const adminOnly = async (c: Context<AppEnv>, next: Next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'API keys are for owners. Ask an owner.' }, 403);
  await next();
};

/** A key as the dashboard and GET /api/v1/keys list it: never the secret or its hash. */
export function publicKey(r: ApiKeyRow, now = Date.now()) {
  const k = parse(r);
  return {
    id: r.id,
    name: r.name,
    hint: r.hint,
    scopes: k.scopes,
    sites: k.sites,
    created_at: r.created_at,
    expires_at: r.expires_at,
    expired: !!r.expires_at && r.expires_at <= now,
    last_used_at: r.last_used_at,
    last_write_at: r.last_write_at,
    calls_24h: callsIn24h(r.hours, now),
  };
}

async function listKeys(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare('SELECT * FROM api_keys ORDER BY created_at').all<ApiKeyRow>();
  return c.json(results.map((r) => publicKey(r)), 200, { 'cache-control': 'no-store' });
}

/** Checks a POST /api/v1/keys body. Exported for tests. */
export async function readKeyBody(db: D1Database, b: Record<string, unknown> | null, now = Date.now()) {
  const name = typeof b?.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { error: 'name is required, such as "pricing-agent"' };
  if (name.length > 64) return { error: 'name has at most 64 characters' };
  const scopes = b?.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !(SCOPES as readonly unknown[]).includes(s))) {
    return { error: `scopes is a list of one or more of ${SCOPES.join(', ')}` };
  }
  let sites: string[] | null = null;
  const raw = b?.sites;
  if (raw !== undefined && raw !== null && raw !== '*' && !(Array.isArray(raw) && raw.length === 1 && raw[0] === '*')) {
    if (!Array.isArray(raw) || !raw.length || raw.some((s) => typeof s !== 'string' || !s)) {
      return { error: 'sites is a list of site ids, or "*" (the default) for every site' };
    }
    sites = [...new Set(raw as string[])];
    const { results } = await db
      .prepare('SELECT id FROM sites WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(sites))
      .all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    const missing = sites.filter((s) => !known.has(s));
    if (missing.length) return { error: `No site has the id ${missing.join(', ')}` };
  }
  let expires_at: number | null = null;
  if (b?.expires_days !== undefined && b.expires_days !== null) {
    const d = Number(b.expires_days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) return { error: 'expires_days is a whole number of days from 1 to 3650, or null for never' };
    expires_at = now + d * 86_400_000;
  } else if (b?.expires_at !== undefined && b.expires_at !== null) {
    const t = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : NaN;
    if (!Number.isFinite(t) || t <= now) return { error: 'expires_at is a time in the future, as ISO 8601' };
    expires_at = t;
  }
  return { name, scopes: SCOPES.filter((s) => (scopes as string[]).includes(s)), sites, expires_at };
}

/** POST /api/v1/keys { name, scopes, sites?, expires_days? | expires_at? }: answers the secret once, as `key`. */
async function createKey(c: Context<AppEnv>) {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const now = Date.now();
  const k = await readKeyBody(c.env.DB, b, now);
  if ('error' in k) return c.json({ error: k.error }, 400);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_KEYS) return c.json({ error: `A deployment can have ${MAX_KEYS} API keys. Revoke one first.` }, 400);
  const secret = KEY_PREFIX + randomId(24);
  const row: ApiKeyRow = {
    hash: await sha256Hex(secret),
    id: randomId(8),
    name: k.name,
    hint: secret.slice(-4),
    scopes: JSON.stringify(k.scopes),
    sites: k.sites ? JSON.stringify(k.sites) : null,
    created_at: now,
    expires_at: k.expires_at,
    last_used_at: null,
    last_write_at: null,
    hours: '[]',
  };
  await c.env.DB.prepare(
    'INSERT INTO api_keys (hash, id, name, hint, scopes, sites, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.hash, row.id, row.name, row.hint, row.scopes, row.sites, row.created_at, row.expires_at, c.get('member')?.id ?? null)
    .run();
  return c.json({ ...publicKey(row, now), key: secret }, 200, { 'cache-control': 'no-store' });
}

/** DELETE /api/v1/keys/:id: the key stops working at once in this isolate, within a minute everywhere. */
async function revokeKey(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  const row = await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ? RETURNING hash').bind(id).first<{ hash: string }>();
  if (!row) return c.json({ error: 'No API key has this id. It may be revoked already.' }, 404);
  // What FounderData Pro's mail kept for the key (migration 0070): its domains, reply-only setting and daily cap.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mail_key_domains WHERE key_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM mail_key_settings WHERE key_id = ?').bind(id),
  ]);
  keyCache.delete(row.hash);
  usage.delete(row.hash);
  return c.json({ ok: true });
}

/** Registers GET, POST /api/v1/keys and DELETE /api/v1/keys/:id. Call it before the /api/* catch-all. */
export function registerKeyRoutes(app: Hono<AppEnv>) {
  app.use('/api/v1/keys', requireAuth, adminOnly);
  app.use('/api/v1/keys/*', requireAuth, adminOnly);
  app.get('/api/v1/keys', listKeys);
  app.post('/api/v1/keys', createKey);
  app.delete('/api/v1/keys/:id', revokeKey);
}
