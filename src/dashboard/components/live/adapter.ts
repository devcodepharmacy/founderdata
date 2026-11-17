import type { LiveData, LiveDevice, LiveEvent, LiveEventKind, LivePlace, LiveSite, LiveVisitor } from './types';

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

const compact = <T,>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

export function parseLive(json: unknown, clock = Date.now()): LiveData {
  const r = obj(json);
  const now = ms(r.now) ?? clock;
  const sites = compact(list(r.sites).map(site));
  const visitors = compact(list(r.visitors).map((v) => visitor(v, now)));
  // A visitor id can appear twice if the server lists sessions; keep the most recent.
  const byId = new Map<string, LiveVisitor>();
  for (const v of visitors) {
    const had = byId.get(v.id);
    if (!had || had.lastSeenAt < v.lastSeenAt) byId.set(v.id, v);
  }
  const events = compact(list(r.events).map(event)).sort((a, b) => b.ts - a.ts);
  const online = num(r.online);
  return {
    now,
    windowMinutes: num(r.windowMinutes) ?? 5,
    online: online != null ? Math.max(0, online) : byId.size,
    sites: sites.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)),
    visitors: [...byId.values()].sort((a, b) => b.startedAt - a.startedAt),
    events: [...new Map(events.map((e) => [e.key, e])).values()],
    places: compact(list(r.places).map(place)),
  };
}
