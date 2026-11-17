import { randomId } from './lib/crypto';
import type { AlertMessage } from './alerts';

/**
 * The alert inbox (migration 0069, docs/API.md "Alert inbox"): every alert message FounderData produced, one row per
 * message and site, so an agent that wakes up can ask what fired since its last run. GET /api/v1/alerts?since= and the
 * MCP tool alert_rules with action events read it. Rows are written where each message is made: the daily alerts
 * (digest.ts), failed payments and cancellations (alerts.ts alertSubscription), refused webhooks and the write cap
 * (alerts.ts), ASO reviews (aso-alerts.ts), rules that fire (alert-rules.ts) and the weekly report. Purchases,
 * renewals and "Daily numbers" stay out: payments hold the first two, and the third is the same every day.
 *
 * Each insert is 1 row (the table's key starts with ts, WITHOUT ROWID). Recording never throws and never stops a send.
 */

export const EVENT_DAYS = 90;
const DAY = 86_400_000;
/** The longest text and data a row keeps, in characters: enough for a 13-site weekly report. */
const TEXT_MAX = 8_000;
const DATA_MAX = 8_000;

export interface NewEvent {
  kind: string;
  site_id: string | null;
  title: string;
  /** The message lines, joined. */
  text?: string;
  data?: Record<string, unknown>;
}

/** Fields that can name a person: never stored. */
const PERSONAL = new Set(['customer_email', 'customer_name', 'customer_id', 'user_id', 'visitor_id', 'email']);

function scrubData(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.map((x) => scrubData(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !PERSONAL.has(k)).map(([k, x]) => [k, scrubData(x, depth + 1)]));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The statements that store `events`, for a caller that batches them with its own writes. A row's ts is the time of
 * the write, never earlier than `now` (the tick or run that made the message): an agent that pages with since=<its last
 * poll> must not miss a row a slow run stored after that poll with an earlier time.
 */
export function eventStatements(db: D1Database, events: NewEvent[], now: number): D1PreparedStatement[] {
  const at = Math.max(now, Date.now());
  return events.map((e, i) => {
    let data = JSON.stringify(scrubData(e.data ?? {}));
    if (data.length > DATA_MAX) data = JSON.stringify({ truncated: true });
    return db
      .prepare('INSERT OR IGNORE INTO alert_events (ts, id, kind, site_id, title, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(at + i, `evt_${randomId(10)}`, e.kind, e.site_id, clip(e.title, 300), clip(e.text ?? '', TEXT_MAX), data);
  });
}

/** Store `events` in one batch (one subrequest). Never throws; returns how many it stored. */
export async function recordEvents(db: D1Database, events: NewEvent[], now = Date.now()): Promise<number> {
  if (!events.length) return 0;
  try {
    const stmts = eventStatements(db, events, now);
    if (stmts.length === 1) await stmts[0].run();
    else await db.batch(stmts);
    return events.length;
  } catch (e) {
    console.error('Alert inbox write failed', e instanceof Error ? e.message : e);
    return 0;
  }
}

/** One event for a message about one site, or the deployment with `siteId` null. */
export const messageEvent = (m: AlertMessage, siteId: string | null, kind: string = m.kind): NewEvent => ({
  kind,
  site_id: siteId,
  title: m.title,
  text: m.lines.join('\n'),
  data: m.data,
});

/**
 * One event per site for a message whose data holds `items` with a site_id (Worth a look, payments stopped, the ASO
 * collector): each site's row keeps its own items and lines.
 */
export function perSiteEvents(build: (siteIds: string[]) => AlertMessage | null, items: { siteId: string }[]): NewEvent[] {
  const ids = [...new Set(items.map((i) => i.siteId))];
  return ids.flatMap((id) => {
    const m = build([id]);
    return m ? [messageEvent(m, id)] : [];
  });
}

/** The statement the 03:17 cleanup runs: rows past EVENT_DAYS. */
export const pruneAlertEvents = (db: D1Database, now = Date.now()) => db.prepare('DELETE FROM alert_events WHERE ts < ?').bind(now - EVENT_DAYS * DAY);
