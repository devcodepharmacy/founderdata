import { hmacHex } from './lib/crypto';

/**
 * Cookieless visitor and session ids (the tracker's default, see docs/GUIDE.md, "Cookies and consent").
 *
 * visitor = HMAC(daily salt, site id | IP | user agent). The salt is HMAC(secret, UTC date), so it changes at
 * 00:00 UTC and can't be recomputed without the secret: the same person gets an unrelated id the next day, and
 * nothing stored links the two. The IP and user agent are only hashed, never stored. The secret is
 * VISITOR_SALT_SECRET when set, else SESSION_SECRET (visitorSecret below), so either can be rotated on its own.
 *
 * session = the visitor's latest session if it was active in the last 30 minutes, otherwise a new id
 * derived from the visitor and the 30-minute slot, so two events racing to start a session agree on it.
 */

const SESSION_MS = 30 * 60_000;

/**
 * The key of the daily salt. VISITOR_SALT_SECRET keeps visitor ids apart from the login: rotating SESSION_SECRET then
 * leaves today's ids as they are, and rotating VISITOR_SALT_SECRET leaves the logins. Unset, it is SESSION_SECRET,
 * as before the option existed.
 */
export function visitorSecret(env: { VISITOR_SALT_SECRET?: string; SESSION_SECRET?: string }): string {
  return env.VISITOR_SALT_SECRET?.trim() || env.SESSION_SECRET || '';
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dailySalt(secret: string, now: number): Promise<string> {
  // The salt label keeps the minilytics name. Changing it would give every cookieless visitor a new id.
  return hmacHex(secret, `minilytics-daily-salt|${utcDay(now)}`);
}

export async function cookielessVisitorId(secret: string, siteId: string, ip: string, ua: string, now: number): Promise<string> {
  return (await hmacHex(await dailySalt(secret, now), `${siteId}|${ip}|${ua}`)).slice(0, 32);
}

/**
 * The daily key of an app launch without a kept install id (src/worker/app.ts, resolveLaunch): the same daily salt
 * over site id, IP, user agent (app name, build, CFNetwork and Darwin version), device model, OS version and locale.
 * The "app" label keeps it apart from web visitor ids. Stored only in app_aliases, prefixed "day_".
 */
export async function appDayKey(
  secret: string,
  siteId: string,
  ip: string,
  ua: string,
  device: { device?: unknown; os_version?: unknown; locale?: unknown },
  now: number,
): Promise<string> {
  const part = (v: unknown) => (typeof v === 'string' ? v.slice(0, 64) : '');
  const input = `app|${siteId}|${ip}|${ua}|${part(device.device)}|${part(device.os_version)}|${part(device.locale)}`;
  return 'day_' + (await hmacHex(await dailySalt(secret, now), input)).slice(0, 32);
}

export async function cookielessIds(
  db: D1Database,
  secret: string,
  siteId: string,
  ip: string,
  ua: string,
  now: number,
): Promise<{ vid: string; sid: string }> {
  const vid = await cookielessVisitorId(secret, siteId, ip, ua, now);
  const last = await db
    .prepare('SELECT id, last_seen_at FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1')
    .bind(siteId, vid)
    .first<{ id: string; last_seen_at: number }>();
  if (last && now - last.last_seen_at < SESSION_MS) return { vid, sid: last.id };
  const sid = (await hmacHex(secret, `session|${vid}|${Math.floor(now / SESSION_MS)}`)).slice(0, 32);
  return { vid, sid };
}

/** The visitor an app install id belongs to: another launch's visitor (app_aliases), else the id itself. */
export async function appVisitorId(db: D1Database, siteId: string, id: string): Promise<string> {
  const row = await db.prepare('SELECT visitor_id FROM app_aliases WHERE site_id = ? AND id = ?').bind(siteId, id).first<{ visitor_id: string }>();
  return row?.visitor_id ?? id;
}

/**
 * The visitor's IP, for the cookieless id. On Cloudflare it is CF-Connecting-IP, which the client can't set. A client
 * can put anything in X-Forwarded-For, so that header only counts when CF-Connecting-IP is missing (local dev), or
 * when the deployment proxies the event endpoint through its own domain and says so with TRUST_FORWARDED_FOR
 * (docs/GUIDE.md, "Beat ad blockers"). Behind such a proxy CF-Connecting-IP is the proxy's address, and the proxy
 * (e.g. a Vercel rewrite) puts the visitor's IP first in X-Forwarded-For.
 */
export function clientIp(header: (name: string) => string | undefined, trustForwardedFor = false): string {
  const xff = header('x-forwarded-for')?.split(',')[0]?.trim();
  const cf = header('cf-connecting-ip')?.trim();
  if (trustForwardedFor && xff) return xff;
  return cf || xff || '';
}

/** TRUST_FORWARDED_FOR is on: "1", "true", "on" or "yes". */
export function trustsForwardedFor(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test(value?.trim() ?? '');
}
