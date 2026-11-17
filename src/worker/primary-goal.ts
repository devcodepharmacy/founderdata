import type { Context, Hono } from 'hono';
import { forgetSite, type AppEnv, type Site } from './env';
import { countedAllSql, countedSql } from './datacenter';
import { sessionsWhere, type Ctx } from './stats';

/**
 * The primary goal of a site (migration 0030, docs/GUIDE.md "Primary goal"): one goal name the owner picks in the
 * site's Settings, such as `newsletter_signup`. Home, GET /api/v1/portfolio and GET /api/v1/weekly count it per site,
 * so a site without revenue has a headline number, and the Content tab counts it per entry page.
 *
 * The count is visitors, not completions: the visitors with a visit that started in the period and sent the goal.
 * A visitor who signs up twice counts once, as a customer does.
 */

export const GOAL_NAME_MAX = 100;
export const GOAL_LABEL_MAX = 40;

/** A site's primary goal over a period against the period before, as /api/home, the portfolio and the weekly report send it. */
export interface SiteGoal {
  /** The goal name the tracker sends. */
  name: string;
  /** How the number reads: the owner's label, else the name in words ("Newsletter signup"). */
  label: string;
  count: number;
  previous: number;
  /** Whole percent against `previous`; null when `previous` is 0. */
  change_pct: number | null;
}

/** "newsletter_signup" as "Newsletter signup". */
export function goalWords(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

export const goalLabel = (s: Pick<Site, 'primary_goal' | 'primary_goal_label'>) => s.primary_goal_label || goalWords(s.primary_goal ?? '');

export function siteGoal(s: Pick<Site, 'primary_goal' | 'primary_goal_label'>, count: number, previous: number): SiteGoal | null {
  if (!s.primary_goal) return null;
  return { name: s.primary_goal, label: goalLabel(s), count, previous, change_pct: previous > 0 ? Math.round(((count - previous) / previous) * 100) : null };
}

/**
 * Visitors who reached each site's primary goal, in the period (`cur` 1) and the period before (`cur` 0), for every
 * site that has one. One statement; sessions without a goal (`goals` 0) never look at their events, and only the sites
 * with a primary goal have their sessions read (site_id leads the index). No sites with a primary goal: no query.
 */
export async function goalCounts(
  db: D1Database,
  sites: Site[],
  range: { from: number; to: number },
  before: { from: number; to: number },
): Promise<Map<string, { cur: number; prev: number }>> {
  const out = new Map<string, { cur: number; prev: number }>();
  if (!sites.some((s) => s.primary_goal)) return out;
  const { results } = await db
    .prepare(
      `SELECT s.site_id, (s.started_at >= ?) AS cur, COUNT(DISTINCT s.visitor_id) AS n
       FROM sessions s JOIN sites st ON st.id = s.site_id
       WHERE s.site_id IN (SELECT id FROM sites WHERE primary_goal IS NOT NULL) AND s.started_at >= ? AND s.started_at < ? AND (s.started_at >= ? OR s.started_at < ?) AND s.goals > 0${countedAllSql('s')}
         AND EXISTS (SELECT 1 FROM events e WHERE e.site_id = s.site_id AND e.session_id = s.id AND e.type = 'goal' AND e.name = st.primary_goal)
       GROUP BY s.site_id, cur`,
    )
    .bind(range.from, before.from, range.to, range.from, before.to)
    .all<{ site_id: string; cur: number; n: number }>();
  for (const r of results) {
    const e = out.get(r.site_id) ?? { cur: 0, prev: 0 };
    if (r.cur) e.cur = r.n;
    else e.prev = r.n;
    out.set(r.site_id, e);
  }
  return out;
}

/**
 * Visitors who reached the site's primary goal per entry page, for the Content tab: the visits of the range that
 * started on the page and sent the goal, with the dashboard filters. Empty without a primary goal.
 */
export async function goalByEntryPage(ctx: Ctx, from = ctx.range.from, to = ctx.range.to): Promise<Map<string, number>> {
  const goal = ctx.site.primary_goal;
  if (!goal) return new Map();
  const w = sessionsWhere(ctx, from, to);
  const { results } = await ctx.db
    .prepare(
      `SELECT s.entry_page AS page, COUNT(DISTINCT s.visitor_id) AS n FROM sessions s
       WHERE ${w.sql} AND s.goals > 0 AND s.entry_page IS NOT NULL
         AND EXISTS (SELECT 1 FROM events e WHERE e.site_id = s.site_id AND e.session_id = s.id AND e.type = 'goal' AND e.name = ?)
       GROUP BY s.entry_page`,
    )
    .bind(...w.params, goal)
    .all<{ page: string; n: number }>();
  return new Map(results.map((r) => [r.page, r.n]));
}

// ---------- GET and PUT /api/sites/:id/goal: the Settings picker

/** Goal names the site sent in the last 90 days, most visitors first: what Settings offers. */
const PICK_DAYS = 90;

/** GET /api/sites/:id/goal → { name, label, options: [{ name, visitors }] } */
async function getGoal(c: Context<AppEnv>) {
  const site = c.get('site');
  const { results } = await c.env.DB.prepare(
    `SELECT name, COUNT(DISTINCT visitor_id) AS visitors FROM events
     WHERE site_id = ? AND ts >= ? AND type = 'goal' AND name IS NOT NULL AND name != ''${countedSql(site.show_datacenter, 'events')}
     GROUP BY name ORDER BY visitors DESC, name LIMIT 50`,
  )
    .bind(site.id, Date.now() - PICK_DAYS * 86_400_000)
    .all<{ name: string; visitors: number }>();
  return c.json({ name: site.primary_goal ?? null, label: site.primary_goal ? goalLabel(site) : null, custom_label: site.primary_goal_label ?? null, days: PICK_DAYS, options: results });
}

/**
 * PUT /api/sites/:id/goal { name: string | null, label?: string | null }. A null or empty name clears the goal (and
 * its label). Writes 1 row.
 */
async function putGoal(c: Context<AppEnv>) {
  const site = c.get('site');
  const b = await c.req.json<{ name?: unknown; label?: unknown }>().catch(() => null);
  if (!b || !('name' in b)) return c.json({ error: 'Send { "name": "signup" }, or { "name": null } to clear it' }, 400);
  if (b.name !== null && typeof b.name !== 'string') return c.json({ error: 'name must be a goal name or null' }, 400);
  if (b.label !== undefined && b.label !== null && typeof b.label !== 'string') return c.json({ error: 'label must be text or null' }, 400);
  const name = (b.name ?? '').trim() || null;
  const label = name ? (typeof b.label === 'string' ? b.label.trim().replace(/\s+/g, ' ') : '') || null : null;
  if (name && name.length > GOAL_NAME_MAX) return c.json({ error: `A goal name has at most ${GOAL_NAME_MAX} characters` }, 400);
  if (label && label.length > GOAL_LABEL_MAX) return c.json({ error: `The label has at most ${GOAL_LABEL_MAX} characters` }, 400);
  await c.env.DB.prepare('UPDATE sites SET primary_goal = ?, primary_goal_label = ? WHERE id = ?').bind(name, label, site.id).run();
  forgetSite(site.id);
  return c.json({ name, label: name ? goalLabel({ primary_goal: name, primary_goal_label: label }) : null, custom_label: label });
}

/** Mounted in index.ts after the login and site middleware of /api/sites/:id/*. */
export function registerPrimaryGoal(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/goal', getGoal);
  app.put('/api/sites/:id/goal', putGoal);
}
