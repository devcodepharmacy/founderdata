// The erase log (migrations 0020 and 0022, docs/PRIVACY.md): one row per erase request with the site, the time, how the
// person was found, the rows each table lost, who handled it (the dashboard login or the site's API key) and an
// optional note. It never stores the visitor id, email or user id that was erased. Deleting a site keeps its rows,
// with the site's name, because they are the proof that a request was answered.
import type { Context, Hono } from 'hono';
import { requireAuth } from './auth';
import { erasePerson, eraseVisitor } from './erase';
import type { AppEnv, Site } from './env';
import { csvRow } from './export';
import { randomId } from './lib/crypto';
import { requireWriteKey } from './keys';

export type ErasureMethod = 'visitor' | 'email' | 'user_id' | 'email+user_id';
/** Who handled an erase request: the admin login in the dashboard, or a script with the site's API key. */
export type ErasureHandler = 'admin' | 'api';

/** Entries one request lists at most, newest first. */
const MAX_ROWS = 1000;
/** Longest note kept. */
const MAX_NOTE = 200;
/** The count columns in the order the CSV shows them; kinds added later follow in name order. */
const KNOWN = ['visitors', 'sessions', 'events', 'claims', 'signals', 'subscriptions', 'payments'];

/** "Acme (acme.example)", or the name alone for an app without a website. */
export const siteLabel = (site: Pick<Site, 'name' | 'domain'>) => (site.domain.endsWith('.invalid') ? site.name : `${site.name} (${site.domain})`);

/** The caller of an erase route: the dashboard's admin login, or the site's API key on /api/v1 (no role set). */
export const handlerOf = (c: Context<AppEnv>): ErasureHandler => (c.get('role') === 'admin' ? 'admin' : 'api');

/** A note for the log from a request: trimmed, one line, at most 200 characters, or null. */
export function cleanNote(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const note = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NOTE);
  return note || null;
}

/** Note an erase request. Only numbers are kept from `result`. 1 row written. */
export async function logErasure(
  db: D1Database,
  site: Site,
  method: ErasureMethod,
  result: object,
  by: { handler: ErasureHandler; note?: string | null },
  now = Date.now(),
): Promise<void> {
  const counts = Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'number'));
  await db
    .prepare('INSERT INTO erasures (site_id, ts, id, method, counts, handled_by, note, site_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(site.id, now, randomId(6), method, JSON.stringify(counts), by.handler, by.note ?? null, siteLabel(site))
    .run();
}

/**
 * When a site is deleted: its erase log stays, with the site's current name. The other tables lose its rows
 * (index.ts, DELETE /api/sites/:id).
 */
export function keepErasures(db: D1Database, site: Site): D1PreparedStatement {
  return db.prepare('UPDATE erasures SET site_name = ? WHERE site_id = ?').bind(siteLabel(site), site.id);
}

interface Row {
  site_id: string;
  ts: number;
  method: ErasureMethod;
  counts: string;
  handled_by: ErasureHandler | null;
  note: string | null;
  site_name: string | null;
}

interface Erasure {
  ts: number;
  method: ErasureMethod;
  /** 'admin', 'api', or null for requests logged before migration 0022. */
  handled_by: ErasureHandler | null;
  note: string | null;
  counts: Record<string, number>;
}

function parseCounts(raw: string): Record<string, number> {
  try {
    return JSON.parse(raw);
  } catch {
    // Unreadable counts: list the request without them.
    return {};
  }
}

const countColumns = (rows: { counts: Record<string, number> }[]) => {
  const seen = new Set(rows.flatMap((r) => Object.keys(r.counts)));
  return [...KNOWN.filter((k) => seen.has(k)), ...[...seen].filter((k) => !KNOWN.includes(k)).sort()];
};

const csvResponse = (body: string, name: string) =>
  new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });

/** GET /api/sites/:id/erasures, JSON, or a CSV file with ?format=csv. */
async function listErasures(c: Context<AppEnv>) {
  const site = c.get('site');
  const res = await c.env.DB.prepare(`SELECT * FROM erasures WHERE site_id = ? ORDER BY ts DESC LIMIT ${MAX_ROWS}`).bind(site.id).all<Row>();
  const rows: Erasure[] = res.results.map((r) => ({ ts: r.ts, method: r.method, handled_by: r.handled_by, note: r.note, counts: parseCounts(r.counts) }));
  if (c.req.query('format') !== 'csv') return c.json(rows);
  const cols = countColumns(rows);
  let body = csvRow(['time', 'method', ...cols, 'handled_by', 'note']);
  for (const r of rows) body += csvRow([new Date(r.ts).toISOString(), r.method, ...cols.map((k) => r.counts[k] ?? 0), r.handled_by, r.note]);
  return csvResponse(body, `${site.domain}-erasures.csv`);
}

/**
 * GET /api/erasures: the erase log of every site, deleted ones included, newest first. Each row names its site as it
 * was when the request was handled; `deleted` is true once the site is gone. JSON, or CSV with ?format=csv.
 */
async function listAllErasures(c: Context<AppEnv>) {
  const res = await c.env.DB.prepare(
    `SELECT e.*, s.id IS NULL AS deleted FROM erasures e LEFT JOIN sites s ON s.id = e.site_id ORDER BY e.ts DESC LIMIT ${MAX_ROWS}`,
  ).all<Row & { deleted: number }>();
  const rows = res.results.map((r) => ({
    ts: r.ts,
    site_id: r.site_id,
    site_name: r.site_name,
    deleted: !!r.deleted,
    method: r.method,
    handled_by: r.handled_by,
    note: r.note,
    counts: parseCounts(r.counts),
  }));
  if (c.req.query('format') !== 'csv') return c.json(rows);
  const cols = countColumns(rows);
  let body = csvRow(['time', 'site_id', 'site', 'site_deleted', 'method', ...cols, 'handled_by', 'note']);
  for (const r of rows) {
    body += csvRow([new Date(r.ts).toISOString(), r.site_id, r.site_name, r.deleted, r.method, ...cols.map((k) => r.counts[k] ?? 0), r.handled_by, r.note]);
  }
  return csvResponse(body, 'erasures.csv');
}

/** The site of the key in `Authorization: Bearer <key>`, for the /api/v1 erase routes: payments:write (keys.ts). */
const requireApiKey = requireWriteKey('payments:write');

export function registerPrivacyRoutes(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/erasures', listErasures);
  app.get('/api/erasures', requireAuth, listAllErasures);
  // Erase from a script with the site's API key (docs/API.md, "Erase one person"); logged as handled by `api`.
  app.post('/api/v1/erase', requireApiKey, erasePerson);
  app.delete('/api/v1/visitors/:vid', requireApiKey, eraseVisitor);
}
