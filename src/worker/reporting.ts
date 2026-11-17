import { Hono } from 'hono';
import { requireAuth } from './auth';
import { forgetSite, type AppEnv } from './env';

/**
 * The reporting timezone: the one timezone the cross-site views count days in, so a number reads the same on web
 * Home, the iPhone's Home, GET /api/v1/portfolio, GET /api/v1/weekly and the Monday report (docs/API.md, "Reporting
 * timezone"). A site's own dashboard keeps counting in the site's timezone; when the two differ, its page says so.
 *
 * Order: a valid `?tz=` on the request (for API callers), then the saved setting (migrations/0031), then the
 * timezone every site shares, then UTC.
 */

export type TimezoneSource = 'request' | 'setting' | 'sites' | 'default';

export interface ReportingZone {
  timezone: string;
  source: TimezoneSource;
}

const KEY = 'reporting_timezone';

export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The saved setting, or null. A database without migration 0031 has none. */
export async function savedTimezone(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare('SELECT value FROM deployment_settings WHERE key = ?').bind(KEY).first<{ value: string }>();
    return row && isTimezone(row.value) ? row.value : null;
  } catch {
    return null;
  }
}

/** Pick the zone from what the caller already loaded: the request's tz, the saved one, the sites' shared one, UTC. */
export function pickTimezone(asked: string | undefined | null, saved: string | null, siteZones: (string | null | undefined)[]): ReportingZone {
  if (isTimezone(asked)) return { timezone: asked, source: 'request' };
  if (saved) return { timezone: saved, source: 'setting' };
  const zones = new Set(siteZones.filter(isTimezone));
  if (zones.size === 1) return { timezone: [...zones][0], source: 'sites' };
  return { timezone: 'UTC', source: 'default' };
}

/** The reporting timezone for a request: `asked` when it is a valid IANA name, else the deployment's. */
export async function reportingTimezone(db: D1Database, asked?: string | null): Promise<ReportingZone> {
  if (isTimezone(asked)) return { timezone: asked, source: 'request' };
  const [saved, zones] = await Promise.all([savedTimezone(db), db.prepare('SELECT DISTINCT timezone FROM sites LIMIT 2').all<{ timezone: string }>()]);
  return pickTimezone(null, saved, zones.results.map((r) => r.timezone));
}

// ---------- the dashboard's setting (Settings, General)

async function state(db: D1Database) {
  const [saved, sites] = await Promise.all([
    savedTimezone(db),
    db.prepare('SELECT id, name, timezone FROM sites ORDER BY created_at').all<{ id: string; name: string; timezone: string }>(),
  ]);
  const zone = pickTimezone(null, saved, sites.results.map((s) => s.timezone));
  return {
    timezone: zone.timezone,
    source: zone.source,
    saved,
    sites: sites.results,
    /** Sites whose own pages count days in another timezone, so their totals there can differ from Home's. */
    differ: sites.results.filter((s) => s.timezone !== zone.timezone).map((s) => s.id),
  };
}

export const settings = new Hono<AppEnv>();
settings.use('*', requireAuth);

settings.get('/reporting-timezone', async (c) => c.json(await state(c.env.DB)));

/** `{ timezone }` saves it; `{ timezone: null }` goes back to the automatic choice. Admin only (requireAuth). */
settings.put('/reporting-timezone', async (c) => {
  const b = await c.req.json<{ timezone?: unknown }>().catch(() => null);
  if (!b || !('timezone' in b)) return c.json({ error: 'Send { "timezone": "Europe/Berlin" }, or null to follow the sites' }, 400);
  if (b.timezone === null || b.timezone === '') {
    await c.env.DB.prepare('DELETE FROM deployment_settings WHERE key = ?').bind(KEY).run();
  } else if (!isTimezone(b.timezone)) {
    return c.json({ error: 'Unknown timezone. Use an IANA name, such as Europe/Berlin or America/New_York.' }, 400);
  } else {
    await c.env.DB.prepare(
      `INSERT INTO deployment_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(KEY, b.timezone, Date.now())
      .run();
  }
  return c.json(await state(c.env.DB));
});

/** Every site counts days in the reporting timezone from now on, so its page and Home agree. One row per site moved. */
settings.post('/reporting-timezone/apply', async (c) => {
  const before = await state(c.env.DB);
  if (before.differ.length) {
    await c.env.DB.prepare('UPDATE sites SET timezone = ? WHERE timezone != ?').bind(before.timezone, before.timezone).run();
    for (const id of before.differ) forgetSite(id);
  }
  // Keep the zone picked even when it came from the sites, so a new site in another timezone does not move Home.
  if (before.source !== 'setting') {
    await c.env.DB.prepare(
      `INSERT INTO deployment_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(KEY, before.timezone, Date.now())
      .run();
  }
  return c.json({ ...(await state(c.env.DB)), moved: before.differ.length });
});
