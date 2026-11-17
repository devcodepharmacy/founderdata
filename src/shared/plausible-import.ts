// Plausible CSV export -> FounderData daily aggregates. Pure code: the dashboard runs it in the browser (so the Worker
// never parses a CSV), and the tests run it in Node. The column names come from Plausible's own CSV importer,
// lib/plausible/imported/csv_importer.ex in github.com/plausible/analytics (docs/GUIDE.md, "Import from Plausible").

/** What one stored day-row holds. `visitors` is a totals object; every other kind maps a label to [visitors, pageviews]. */
export type ImportKind =
  | 'visitors'
  | 'source'
  | 'campaign'
  | 'keyword'
  | 'page'
  | 'entry_page'
  | 'exit_page'
  | 'country'
  | 'device'
  | 'browser'
  | 'os'
  | 'goal'
  // DataFast only: revenue per day (data {r, n}: minor units, payments) and per source (label -> [minor units, payments]).
  | 'revenue'
  | 'source_revenue';

export const IMPORT_KINDS: readonly ImportKind[] = [
  'visitors', 'source', 'campaign', 'keyword', 'page', 'entry_page', 'exit_page', 'country', 'device', 'browser', 'os', 'goal', 'revenue', 'source_revenue',
];

/** The totals of one day: visitors, pageviews, visits, bounced visits, and the visits' total duration in seconds. */
export interface DayTotals {
  v: number;
  p: number;
  s: number;
  b: number;
  d: number;
  /** 1: the source does not report bounces and visit seconds (DataFast), so the day stays out of bounce rate and duration. */
  n?: 1;
}
export type DayLabels = Record<string, [number, number]>;
export interface DayRow {
  kind: ImportKind;
  day: string;
  data: DayTotals | DayLabels | { r: number; n: number };
}

/** Most labels kept for one kind on one day (the ones with the most visitors). Plausible exports every page. */
export const MAX_LABELS = 1000;
export const MAX_LABEL_LENGTH = 300;

/** Plausible's tables, with the columns that tell them apart. */
export const PLAUSIBLE_TABLES = [
  'imported_visitors',
  'imported_sources',
  'imported_pages',
  'imported_entry_pages',
  'imported_exit_pages',
  'imported_locations',
  'imported_devices',
  'imported_browsers',
  'imported_operating_systems',
  'imported_custom_events',
] as const;
export type PlausibleTable = (typeof PLAUSIBLE_TABLES)[number];

/** Which table a header row belongs to, from the columns only (a renamed file still works). */
export function tableOf(header: string[]): PlausibleTable | null {
  const h = new Set(header);
  if (!h.has('date')) return null;
  if (h.has('link_url')) return 'imported_custom_events';
  if (h.has('entry_page')) return 'imported_entry_pages';
  if (h.has('exit_page')) return 'imported_exit_pages';
  if (h.has('utm_medium') || h.has('referrer')) return 'imported_sources';
  if (h.has('operating_system')) return 'imported_operating_systems';
  if (h.has('browser')) return 'imported_browsers';
  if (h.has('device')) return 'imported_devices';
  if (h.has('country')) return 'imported_locations';
  if (h.has('page')) return 'imported_pages';
  if (h.has('visitors') && h.has('visits')) return 'imported_visitors';
  return null;
}

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes. Skips empty lines and a leading BOM. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

export function validDay(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-01-01';
}

const num = (s: string | undefined) => {
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
};

export interface FileReport {
  name: string;
  /** The Plausible table, or null for a file this import does not read. */
  table: PlausibleTable | null;
  /** Data rows read. */
  rows: number;
  /** Rows left out: a bad date, an empty value or an outbound link. */
  skipped: number;
  note?: string;
}

export interface ImportPreview {
  /** First and last day with data, YYYY-MM-DD; null when nothing could be read. */
  from: string | null;
  to: string | null;
  days: number;
  /** Rows in the CSV files that were read. */
  csvRows: number;
  /** Day-rows the import writes to D1: one per kind per day. */
  dayRows: number;
  /** Day-rows that lost labels beyond MAX_LABELS. */
  truncated: number;
  totals: { visitors: number; pageviews: number };
  files: FileReport[];
  perKind: Partial<Record<ImportKind, number>>;
  warnings: string[];
}

/** Stored label of a visit with no source. The Worker reads it as null, the label native direct visits have. */
export const DIRECT = '';

/** Value of a column, trimmed and clipped; '' when the column is missing. */
const clip = (s: string | undefined) => (s ?? '').trim().slice(0, MAX_LABEL_LENGTH);

/** The labels one row of a table adds to each kind: [kind, label]. A null label leaves the row out of that kind. */
function labelsOf(table: PlausibleTable, get: (c: string) => string): [ImportKind, string | null][] {
  switch (table) {
    case 'imported_sources': {
      const source = clip(get('source'));
      return [
        ['source', !source || source === 'Direct / None' ? DIRECT : source],
        ['campaign', clip(get('utm_campaign')) || null],
        ['keyword', clip(get('utm_term')) || null],
      ];
    }
    case 'imported_pages':
      return [['page', clip(get('page')) || null]];
    case 'imported_entry_pages':
      return [['entry_page', clip(get('entry_page')) || null]];
    case 'imported_exit_pages':
      return [['exit_page', clip(get('exit_page')) || null]];
    case 'imported_locations': {
      const c = clip(get('country')).toUpperCase();
      return [['country', /^[A-Z]{2}$/.test(c) && c !== 'ZZ' && c !== 'XX' ? c : null]];
    }
    case 'imported_devices':
      return [['device', clip(get('device')) || null]];
    case 'imported_browsers':
      return [['browser', clip(get('browser')) || null]];
    case 'imported_operating_systems':
      return [['os', clip(get('operating_system')) || null]];
    case 'imported_custom_events':
      // Outbound link and file download events carry a link_url: they are not goals.
      return [['goal', get('link_url') ? null : clip(get('name')) || null]];
    default:
      return [];
  }
}

/**
 * Turn the text of Plausible's CSV files into daily rows. `files` are the CSVs of the export (zip entries or files the
 * person picked). Files this import does not read (custom props, anything else) are listed with a note.
 */
export function aggregate(files: { name: string; text: string }[]): { rows: DayRow[]; preview: ImportPreview } {
  const totals = new Map<string, DayTotals>();
  const labels = new Map<string, Map<string, [number, number]>>(); // `${kind}|${day}` -> label -> [visitors, pageviews]
  const reports: FileReport[] = [];
  const warnings: string[] = [];
  let csvRows = 0;

  for (const f of files) {
    const base = f.name.split('/').pop() ?? f.name;
    const report: FileReport = { name: base, table: null, rows: 0, skipped: 0 };
    reports.push(report);
    if (!/\.csv$/i.test(base)) {
      report.note = 'Not a CSV file';
      continue;
    }
    if (/custom_props/.test(base)) {
      report.note = 'Custom properties are not imported';
      continue;
    }
    const grid = parseCsv(f.text);
    if (!grid.length) {
      report.note = 'Empty file';
      continue;
    }
    const header = grid[0].map((h) => h.trim().toLowerCase());
    const table = tableOf(header);
    if (!table) {
      report.note = 'Columns not recognized as a Plausible export';
      continue;
    }
    report.table = table;
    const col = new Map(header.map((h, i) => [h, i]));
    for (let r = 1; r < grid.length; r++) {
      const line = grid[r];
      const get = (c: string) => (col.has(c) ? (line[col.get(c)!] ?? '') : '');
      const day = get('date').trim();
      report.rows++;
      if (!validDay(day)) {
        report.skipped++;
        continue;
      }
      const visitors = num(get('visitors'));
      if (table === 'imported_visitors') {
        const t = totals.get(day) ?? { v: 0, p: 0, s: 0, b: 0, d: 0 };
        t.v += visitors;
        t.p += num(get('pageviews'));
        t.s += num(get('visits'));
        t.b += num(get('bounces'));
        t.d += num(get('visit_duration'));
        totals.set(day, t);
        continue;
      }
      // Pages count pageviews; custom events count `events`.
      const views = table === 'imported_custom_events' ? num(get('events')) : num(get('pageviews'));
      let used = false;
      for (const [kind, label] of labelsOf(table, get)) {
        if (label === null) continue;
        used = true;
        const key = `${kind}|${day}`;
        let m = labels.get(key);
        if (!m) labels.set(key, (m = new Map()));
        const cur = m.get(label);
        if (cur) {
          cur[0] += visitors;
          cur[1] += views;
        } else m.set(label, [visitors, views]);
      }
      if (!used) report.skipped++;
    }
    csvRows += report.rows;
  }

  const rows: DayRow[] = [];
  let truncated = 0;
  const perKind: Partial<Record<ImportKind, number>> = {};
  for (const [day, data] of totals) rows.push({ kind: 'visitors', day, data });
  for (const [key, m] of labels) {
    const [kind, day] = key.split('|') as [ImportKind, string];
    let entries = [...m];
    if (entries.length > MAX_LABELS) {
      entries = entries.sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, MAX_LABELS);
      truncated++;
    }
    rows.push({ kind, day, data: Object.fromEntries(entries) as DayLabels });
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  for (const r of rows) perKind[r.kind] = (perKind[r.kind] ?? 0) + 1;

  const days = new Set(rows.map((r) => r.day));
  const sorted = [...days].sort();
  if (!totals.size && rows.length) warnings.push('There is no imported_visitors file, so the chart and the top numbers get no imported days. The panels still do.');
  if (!rows.length) warnings.push('No rows could be read. Choose the zip Plausible emailed you, or its CSV files.');
  if (truncated) warnings.push(`${truncated} days had more than ${MAX_LABELS} rows in one panel. Only the ${MAX_LABELS} with the most visitors are kept.`);
  let visitors = 0;
  let pageviews = 0;
  for (const t of totals.values()) {
    visitors += t.v;
    pageviews += t.p;
  }
  return {
    rows,
    preview: {
      from: sorted[0] ?? null,
      to: sorted[sorted.length - 1] ?? null,
      days: days.size,
      csvRows,
      dayRows: rows.length,
      truncated,
      totals: { visitors, pageviews },
      files: reports,
      perKind,
      warnings,
    },
  };
}
