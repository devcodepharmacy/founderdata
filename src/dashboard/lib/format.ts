export function fmtNumber(n: number): string {
  if (n >= 10_000) return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n).toLowerCase();
  return new Intl.NumberFormat('en').format(Math.round(n));
}

export function fmtMoney(minor: number, currency: string, decimals: number, compact = false): string {
  const v = minor / 10 ** decimals;
  const small = !compact && Math.abs(v) < 10 && v !== 0;
  // Under 10 the cents show, and always as two digits: $1.90, never $1.9. A whole amount stays $4.
  const cents = small && decimals > 0 && Math.round(v * 10 ** decimals) % 10 ** decimals !== 0;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      notation: compact && Math.abs(v) >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: compact || Math.abs(v) >= 1000 ? 0 : small ? 2 : 0,
      minimumFractionDigits: cents ? 2 : 0,
    }).format(v);
  } catch {
    return `${v.toFixed(decimals)} ${currency}`;
  }
}

/** An amount in major units (4.9 is 4.90), as the App Store sales API sends it. */
export function fmtMajor(amount: number, currency: string, compact = false): string {
  const decimals = currencyDecimals(currency);
  return fmtMoney(Math.round(amount * 10 ** decimals), currency, decimals, compact);
}

/** Several currencies on one line, "€12.40, $4.00". Never added together. */
export function fmtMajorList(list: { currency: string; amount: number }[], compact = false): string {
  return list.length ? list.map((m) => fmtMajor(m.amount, m.currency, compact)).join(', ') : '–';
}

/** Minor-unit digits of a currency (EUR 2, JPY 0), matching the server. */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function fmtPct(n: number, digits = 0): string {
  const v = n * 100;
  return `${v < 1 && v > 0 && digits === 0 ? v.toFixed(2) : v.toFixed(digits)}%`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

export function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return 'a few seconds';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'a minute' : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour' : `${h} hours`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? 'a day' : `${d} days`;
  const mo = Math.round(d / 30);
  return mo === 1 ? 'a month' : `${mo} months`;
}

export function fmtDateTime(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(ts);
}

/** YYYY-MM-DD of a timestamp in the site's timezone. */
export function dayInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

export function bucketLabel(bucket: string, g: string, long = false): string {
  if (g === 'hour') {
    const d = new Date(bucket + ':00Z');
    const time = d.toLocaleTimeString('en', { hour: 'numeric', timeZone: 'UTC' });
    return long ? `${d.toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${time}` : time;
  }
  if (g === 'month') {
    return new Date(bucket + '-01T00:00:00Z').toLocaleDateString('en', { month: 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' });
  }
  const d = new Date(bucket + 'T00:00:00Z');
  const s = d.toLocaleDateString('en', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return g === 'week' && long ? `Week of ${s}` : long ? d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : s;
}

/** A country's flag as two regional indicator letters, or null for an unknown country (the caller draws a globe). */
export function flag(cc: string | null | undefined): string | null {
  if (!cc || cc.length !== 2 || cc === 'XX' || cc === 'T1') return null;
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(cc: string | null | undefined): string {
  if (!cc) return 'Unknown';
  try {
    return regionNames?.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

let languageNames: Intl.DisplayNames | null | undefined;

/** "de" as "German". The browser language a visit sent (sessions.language); null is Unknown. */
export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  try {
    if (languageNames === undefined) languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function shortId(id: string) {
  return id.replace(/-/g, '').slice(0, 6);
}

/**
 * How a tile shows its change against the previous period. Never a percentage from a zero, never NaN or Infinity:
 * `noData` (nothing measured before) says so, a zero or small base (`prev < minBase`) gives the absolute change.
 */
export type ChangeView =
  | { kind: 'none'; text: string }
  | { kind: 'noData'; text: string }
  | { kind: 'abs' | 'pct'; text: string; up: boolean };

export function changeView(cur: number, prev: number, opts: { minBase?: number; noData?: boolean; fmt?: (n: number) => string } = {}): ChangeView {
  const fmt = opts.fmt ?? fmtNumber;
  if (opts.noData) return { kind: 'noData', text: 'no data before' };
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return { kind: 'noData', text: 'no data before' };
  if (cur === prev) return { kind: 'none', text: 'no change' };
  const up = cur > prev;
  const arrow = up ? '↑' : '↓';
  if (prev <= 0 || prev < (opts.minBase ?? 0)) return { kind: 'abs', up, text: `${up ? '+' : '−'}${fmt(Math.abs(cur - prev))} ${arrow}` };
  // Half away from zero, like the Home ranking and the iPhone: -10.5% reads 11% down either way.
  return { kind: 'pct', up, text: `${Math.round(Math.abs(((cur - prev) / prev) * 100))}% ${arrow}` };
}

/**
 * What a missing comparison says in a title or to a screen reader. A tile shows a muted dash with this title and a
 * table cell shows nothing, so "no data before" does not repeat down a column (ui/ChangeBadge: NoComparison).
 */
export const NO_COMPARISON = 'No data in the period before';

/**
 * A visit's source as a person reads it: the source's name, or "Came directly" for Direct/None (typed the address, a
 * bookmark, or a link that sends no referrer). The visitor profile and FounderData Pro's People section use it.
 */
export function sourceText(source: string | null | undefined): string {
  if (!source || /^(direct(\/none)?|none|\(none\))$/i.test(source)) return 'Came directly';
  return source;
}
