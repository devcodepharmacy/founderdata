const DAY = 86_400_000;
const HOUR = 3_600_000;

/** One formatter per timezone: building one costs more than using it, and offsetsIn asks about 35 times. */
const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC in ms at `at` (positive east of UTC). */
export function tzOffset(tz: string, at: number = Date.now()): number {
  try {
    const parts = formatFor(tz).formatToParts(new Date(at));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUTC - Math.floor(at / 1000) * 1000) / 60_000) * 60_000;
  } catch {
    return 0;
  }
}

/** Midnight (site time) of the day containing `at`, as a UTC timestamp. */
export function startOfDay(at: number, tz: string): number {
  const off = tzOffset(tz, at);
  const local = Math.floor((at + off) / DAY) * DAY;
  // On a daylight saving day the offset at midnight differs from the offset at `at`.
  return local - tzOffset(tz, local - off);
}

/** Parse YYYY-MM-DD as midnight in the site's timezone. */
function parseDay(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return utc - tzOffset(tz, utc);
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface Range {
  from: number;
  to: number;
  granularity: Granularity;
}

export const PERIODS = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', '12m', 'thisquarter', 'lastquarter', 'all', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The calendar day (YYYY-MM-DD) in `tz` at `at`. */
export const dayInTz = (at: number, tz: string) => isoDay(at + tzOffset(tz, at));

/**
 * The calendar quarter that contains `day` (YYYY-MM-DD), moved by `shift` quarters, as its first and last day.
 * quarterOf('2026-10-30', -1) is { from: '2026-07-01', to: '2026-09-30' }.
 */
export function quarterOf(day: string, shift = 0): { from: string; to: string } {
  const y = Number(day.slice(0, 4));
  const q = Math.floor((Number(day.slice(5, 7)) - 1) / 3) + shift;
  return { from: isoDay(Date.UTC(y, q * 3, 1)), to: isoDay(Date.UTC(y, q * 3 + 3, 0)) };
}

/** Midnight in `tz` that starts the day YYYY-MM-DD (found from local noon, so daylight saving cannot shift the day). */
export function midnight(day: string, tz: string): number {
  const noon = Date.parse(`${day}T12:00:00Z`);
  return startOfDay(noon - tzOffset(tz, noon), tz);
}

export function resolveRange(
  q: { period?: string; from?: string; to?: string; granularity?: string },
  tz: string,
  siteCreatedAt: number,
  now = Date.now(),
): Range {
  const today = startOfDay(now, tz);
  let from: number;
  let to = now;
  switch (q.period as Period) {
    case 'today':
      from = today;
      break;
    case 'yesterday':
      from = startOfDay(today - 1, tz);
      to = today;
      break;
    case '24h':
      from = now - 24 * HOUR;
      break;
    case '48h':
      from = now - 48 * HOUR;
      break;
    case '7d':
      from = startOfDay(today - 6 * DAY + HOUR, tz);
      break;
    case '90d':
      from = startOfDay(today - 89 * DAY + HOUR, tz);
      break;
    case '12m':
      from = startOfDay(today - 364 * DAY + HOUR, tz);
      break;
    case 'thisquarter':
      from = midnight(quarterOf(dayInTz(now, tz)).from, tz);
      break;
    case 'lastquarter': {
      const thisQ = quarterOf(dayInTz(now, tz));
      from = midnight(quarterOf(thisQ.from, -1).from, tz);
      to = midnight(thisQ.from, tz);
      break;
    }
    case 'all':
      from = startOfDay(siteCreatedAt, tz);
      break;
    case 'custom': {
      const f = q.from ? parseDay(q.from, tz) : null;
      const t = q.to ? parseDay(q.to, tz) : null;
      from = f ?? today;
      // `to` is inclusive of the whole day.
      to = Math.min(t !== null ? startOfDay(t + DAY + HOUR, tz) : now, now);
      if (to <= from) to = from + DAY;
      break;
    }
    case '30d':
    default:
      from = startOfDay(today - 29 * DAY + HOUR, tz);
  }
  const span = to - from;
  const auto: Granularity = span <= 2 * DAY + HOUR ? 'hour' : span <= 120 * DAY ? 'day' : span <= 400 * DAY ? 'week' : 'month';
  const g = (['hour', 'day', 'week', 'month'] as const).includes(q.granularity as Granularity)
    ? (q.granularity as Granularity)
    : auto;
  // Hourly buckets over months would be thousands of points; fall back to the automatic choice.
  const granularity = g === 'hour' && span > 7 * DAY ? auto : g;
  return { from, to, granularity };
}

/**
 * The period a range is compared with. Rolling periods take the same length right before. A quarter takes the
 * quarter before: all of it for last quarter, and the same stretch from its first day for this quarter, so
 * 30 days into October compare with July 1 to 30.
 */
export function previousRange(range: Range, period: string | undefined, tz: string): { from: number; to: number } {
  if (period === 'thisquarter' || period === 'lastquarter') {
    const from = midnight(quarterOf(dayInTz(range.from, tz), -1).from, tz);
    return { from, to: period === 'lastquarter' ? range.from : Math.min(from + (range.to - range.from), range.from) };
  }
  return { from: range.from - (range.to - range.from), to: range.from };
}

/**
 * A timezone's offset from UTC over a range: one number, or `[[from, before], [switchAt, after]]` when daylight saving
 * starts or ends inside it (offsetsIn). bucketSql, bucketOf and bucketLabels take either.
 */
export type Offsets = number | [number, number][];

/**
 * The offsets of `tz` over [from, to): the offset at `from`, and the instant it changes when it differs at the end,
 * found by halving (about 35 lookups). A range with two changes and the same offset at both ends (12 months, all)
 * gets one number, as before; its buckets are weeks or months, where an hour does not move a row.
 */
export function offsetsIn(tz: string, from: number, to: number): Offsets {
  const before = tzOffset(tz, from);
  const after = tzOffset(tz, to - 1);
  if (before === after) return before;
  let lo = from;
  let hi = to - 1;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (tzOffset(tz, mid) === before) lo = mid;
    else hi = mid;
  }
  // tzOffset reads whole seconds, so the change is at the second `hi` falls in.
  return [[from, before], [Math.floor(hi / 1000) * 1000, after]];
}

/** The offset in effect at `at`. */
const offsetAt = (o: Offsets, at: number) => (typeof o === 'number' ? o : o.reduce((v, [since, off]) => (at >= since ? off : v), o[0][1]));

/** SQLite expression that turns a ms timestamp column into a bucket label in site time. */
export function bucketSql(col: string, g: Granularity, offsets: Offsets): string {
  const off =
    typeof offsets === 'number'
      ? `${Math.trunc(offsets)}`
      : `(CASE ${offsets
          .slice(1)
          .reverse()
          .map(([since, o]) => `WHEN ${col} >= ${Math.trunc(since)} THEN ${Math.trunc(o)}`)
          .join(' ')} ELSE ${Math.trunc(offsets[0][1])} END)`;
  const t = `((${col} + ${off}) / 1000)`;
  switch (g) {
    case 'hour':
      return `strftime('%Y-%m-%dT%H:00', ${t}, 'unixepoch')`;
    case 'day':
      return `strftime('%Y-%m-%d', ${t}, 'unixepoch')`;
    case 'week':
      return `date(${t}, 'unixepoch', 'weekday 0', '-6 days')`;
    case 'month':
      return `strftime('%Y-%m', ${t}, 'unixepoch')`;
  }
}

/** The bucket label of a ms timestamp in site time: bucketSql in JavaScript, for rows already in memory. */
export function bucketOf(at: number, g: Granularity, offsets: Offsets): string {
  const d = new Date(at + Math.trunc(offsetAt(offsets, at)));
  const iso = d.toISOString();
  if (g === 'hour') return iso.slice(0, 13) + ':00';
  if (g === 'day') return iso.slice(0, 10);
  if (g === 'month') return iso.slice(0, 7);
  // Monday of this week (matches SQLite 'weekday 0', '-6 days', i.e. next Sunday minus 6).
  const daysToSunday = (7 - d.getUTCDay()) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToSunday - 6)).toISOString().slice(0, 10);
}

/**
 * Every bucket label in the range, so the chart has no gaps. Mirrors bucketSql. The label of the range's last instant
 * always counts: steps of 24 hours from a midnight end an hour short of the last day once the clocks went back.
 */
export function bucketLabels(range: Range, offsets: Offsets): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  // A step shorter than the shortest bucket, even with a clock change in it, visits every bucket. 6 days for a week and
  // 27 for a month keep a year of weeks to about 60 label checks instead of 365.
  const step = range.granularity === 'hour' ? HOUR : range.granularity === 'week' ? 6 * DAY : range.granularity === 'month' ? 27 * DAY : DAY;
  const add = (t: number) => {
    const label = bucketOf(t, range.granularity, offsets);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };
  for (let t = range.from; t < range.to; t += step) add(t);
  if (range.to > range.from) add(range.to - 1);
  return labels;
}
