/** The live view's data, after the adapter (adapter.ts) has read GET /api/live. */

export type LivePlatform = 'web' | 'app';
export type LiveDevice = 'desktop' | 'mobile' | 'tablet' | null;
export type LiveEventKind = 'payment' | 'trial' | 'signup' | 'goal';

export interface LiveSite {
  id: string;
  name: string;
  domain: string;
  online: number;
}

export interface LiveVisitor {
  id: string;
  siteId: string;
  platform: LivePlatform;
  country: string | null;
  region: string | null;
  city: string | null;
  /** One decimal at most. Null when the server has no city for the visitor: the globe falls back to the country. */
  lat: number | null;
  lon: number | null;
  page: string | null;
  source: string | null;
  device: LiveDevice;
  customer: boolean;
  startedAt: number;
  lastSeenAt: number;
}

export interface LiveEvent {
  /** Built by the adapter from the event's fields; stable across polls. */
  key: string;
  ts: number;
  siteId: string;
  kind: LiveEventKind;
  label: string | null;
  /** Minor units of `currency`; null for events without money. */
  amount: number | null;
  currency: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

export interface LivePlace {
  key: string;
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  visitors: number;
}

export interface LiveData {
  now: number;
  windowMinutes: number;
  online: number;
  sites: LiveSite[];
  visitors: LiveVisitor[];
  events: LiveEvent[];
  places: LivePlace[];
}

/**
 * `loading` before the first answer, `ready` with data, `error` after a failed poll with no data yet (with data, a
 * failure keeps the last answer and sets `stale`), `unsupported` when the server has no /api/live (a 404: older than
 * this dashboard).
 */
export type LiveStatus = 'loading' | 'ready' | 'error' | 'unsupported';

export interface LiveState {
  status: LiveStatus;
  data: LiveData | null;
  /** The last poll failed; `data` is from an earlier one. */
  stale: boolean;
  /** When the shown data arrived (browser clock). */
  updatedAt: number | null;
  demo: boolean;
  /** Poll again now. */
  refresh: () => void;
}
