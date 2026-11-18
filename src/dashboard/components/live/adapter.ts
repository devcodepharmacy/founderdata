import type { LiveData, LiveDevice, LiveEvent, LiveEventKind, LivePlace, LiveRevenue, LiveSite, LiveVisitor, LiveWindowSite } from './types';

/**
 * Reads a GET /api/live answer into LiveData. All knowledge of the wire format lives here, so a renamed field is a
 * one-line change. Unknown or malformed values become null instead of throwing: one bad row never blanks the view.
 * Coordinates are cut to one decimal on the way in, whatever the server sends.
 */

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** The first field present, for names the backend may still settle on. */
const pick = (r: Raw, ...keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return null;
};
/** Milliseconds; a value under 1e12 is taken as seconds. */
const ms = (v: unknown): number | null => {
  const n = num(v) ?? (typeof v === 'string' ? Date.parse(v) : null);
  if (n == null || !Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
};
const coord = (v: unknown, max: number): number | null => {
  const n = num(v);
  return n == null || Math.abs(n) > max ? null : Math.round(n * 10) / 10;
};
const country = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[a-z]{2}$/i.test(s) && !/^(xx|t1)$/i.test(s) ? s.toUpperCase() : null;
};

const KINDS: LiveEventKind[] = ['payment', 'trial', 'signup', 'goal'];
const DEVICES = ['desktop', 'mobile', 'tablet'];

function site(r: Raw): LiveSite | null {
  const id = str(pick(r, 'id', 'siteId'));
  if (!id) return null;
  return { id, name: str(r.name) ?? str(r.domain) ?? id, domain: str(r.domain) ?? '', online: Math.max(0, num(r.online) ?? 0) };
}

function visitor(r: Raw, now: number): LiveVisitor | null {
  const id = str(pick(r, 'id', 'visitorId', 'sessionId'));
  if (!id) return null;
  const device = str(r.device)?.toLowerCase() ?? null;
  const lastSeenAt = ms(pick(r, 'lastSeenAt', 'lastSeen', 'ts')) ?? now;
  return {
    id,
    siteId: str(pick(r, 'siteId', 'site')) ?? '',
    platform: str(r.platform) === 'app' ? 'app' : 'web',
    country: country(r.country),
    region: str(r.region),
    city: str(r.city),
    lat: coord(r.lat, 90),
    lon: coord(pick(r, 'lon', 'lng'), 180),
    page: str(pick(r, 'page', 'path', 'screen')),
    source: str(pick(r, 'source', 'referrer')),
    device: (device && DEVICES.includes(device) ? device : null) as LiveDevice,
    customer: r.customer === true || r.customer === 1,
    startedAt: ms(pick(r, 'startedAt', 'started')) ?? lastSeenAt,
    lastSeenAt,
  };
}

function event(r: Raw): LiveEvent | null {
  const ts = ms(pick(r, 'ts', 'at', 'createdAt'));
  const kind = str(r.kind) as LiveEventKind | null;
  if (ts == null || !kind || !KINDS.includes(kind)) return null;
  const e = {
    ts,
    siteId: str(pick(r, 'siteId', 'site')) ?? '',
    kind,
    label: str(r.label),
    amount: num(r.amount),
    currency: str(r.currency)?.toUpperCase() ?? null,
    country: country(r.country),
    city: str(r.city),
    lat: coord(r.lat, 90),
    lon: coord(pick(r, 'lon', 'lng'), 180),
  };
  const key = str(r.id) ?? [e.ts, e.siteId, e.kind, e.amount ?? '', e.currency ?? '', e.city ?? e.country ?? ''].join('|');
  return { key, ...e };
}

function place(r: Raw): LivePlace | null {
  const visitors = num(pick(r, 'visitors', 'count')) ?? 0;
  const p = { country: country(r.country), city: str(r.city), lat: coord(r.lat, 90), lon: coord(pick(r, 'lon', 'lng'), 180), visitors };
  if (!p.country && (p.lat == null || p.lon == null)) return null;
  return { key: `${p.country ?? ''}|${p.city ?? ''}|${p.lat ?? ''}|${p.lon ?? ''}`, ...p };
}

function windowSite(r: Raw): LiveWindowSite | null {
  const id = str(pick(r, 'id', 'siteId'));
  const visitors = num(r.visitors) ?? 0;
  if (!id || visitors <= 0) return null;
  return { id, name: str(r.name) ?? str(r.domain) ?? id, domain: str(r.domain) ?? '', visitors };
}

function revenue(r: Raw): LiveRevenue | null {
  const currency = str(r.currency)?.toUpperCase();
  const amount = num(r.amount);
  if (!currency || amount == null) return null;
  return { currency, amount, payments: Math.max(0, num(r.payments) ?? 0) };
}

const unique = (events: LiveEvent[]): LiveEvent[] => [...new Map(events.map((e) => [e.key, e])).values()];

const compact = <T,>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

/** One entry per id: a visitor id can appear twice if the server lists sessions, so keep the most recent. */
function latest(visitors: LiveVisitor[]): Map<string, LiveVisitor> {
  const byId = new Map<string, LiveVisitor>();
  for (const v of visitors) {
    const had = byId.get(v.id);
    if (!had || had.lastSeenAt < v.lastSeenAt) byId.set(v.id, v);
  }
  return byId;
}

export function parseLive(json: unknown, clock = Date.now()): LiveData {
  const r = obj(json);
  const now = ms(r.now) ?? clock;
  const sites = compact(list(r.sites).map(site));
  const byId = latest(compact(list(r.visitors).map((v) => visitor(v, now))));
  const events = compact(list(r.events).map(event)).sort((a, b) => b.ts - a.ts);
  const online = num(r.online);
  const recent = [...latest(compact(list(r.recent).map((v) => visitor(v, now)))).values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return {
    now,
    windowMinutes: num(r.windowMinutes) ?? 5,
    online: online != null ? Math.max(0, online) : byId.size,
    sites: sites.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)),
    visitors: [...byId.values()].sort((a, b) => b.startedAt - a.startedAt),
    events: unique(events),
    places: compact(list(r.places).map(place)),
    recent,
    // An older server sends the list without a count: the list's length is then the best number there is.
    recentCount: Math.max(0, num(r.recentCount) ?? recent.length),
    recentSites: compact(list(r.recentSites).map(windowSite)).sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name)),
    recentRevenue: compact(list(r.recentRevenue).map(revenue)).sort((a, b) => b.amount - a.amount),
    recentEvents: unique(compact(list(r.recentEvents).map(event)).sort((a, b) => b.ts - a.ts)),
    recentAt: Array.isArray(r.recent) ? now : null,
  };
}

/**
 * The visitors the live page lists. Without a window: the visitors online, as parsed. With one: everyone seen in it,
 * the online visitors' fresher rows winning over the window's list, newest activity first.
 */
export function feedVisitors(data: LiveData | null, withRecent: boolean): LiveVisitor[] {
  if (!data) return [];
  if (!withRecent) return data.visitors;
  const byId = new Map<string, LiveVisitor>();
  for (const v of data.recent) byId.set(v.id, v);
  for (const v of data.visitors) byId.set(v.id, v);
  return [...byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * A window's events and money, kept current between the window's refreshes: the events the server read for the window
 * plus the ones every poll has brought since, and the payments per currency with the newer ones added. `minutes` cuts
 * both lists to the window.
 */
export function windowActivity(data: LiveData, minutes: number): { events: LiveEvent[]; revenue: LiveRevenue[] } {
  const since = data.now - minutes * 60_000;
  const events = unique([...data.events, ...data.recentEvents].filter((e) => e.ts > since).sort((a, b) => b.ts - a.ts));
  const by = new Map(data.recentRevenue.map((r) => [r.currency, { ...r }]));
  for (const e of data.events) {
    if (e.kind !== 'payment' || e.amount == null || !e.currency || e.ts <= since || (data.recentAt !== null && e.ts <= data.recentAt)) continue;
    const r = by.get(e.currency) ?? { currency: e.currency, amount: 0, payments: 0 };
    by.set(e.currency, { ...r, amount: r.amount + e.amount, payments: r.payments + 1 });
  }
  return { events, revenue: [...by.values()].sort((a, b) => b.amount - a.amount) };
}
