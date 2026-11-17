import { useEffect, useRef, useState } from 'react';
import { api, type Site } from '../lib/api';
import { aggregate, type DayRow, type ImportPreview } from '../../shared/plausible-import';
import { readZip } from '../../shared/zip';
import { DataFastImport } from './DataFastImport';

interface ImportItem {
  id: string;
  source: string;
  status: 'importing' | 'done';
  from: string;
  to: string;
  rows: number;
  created_at: number;
  /** Day-rows stored so far, on an unfinished import. */
  stored?: number;
  files?: { name: string }[];
}
interface ImportList {
  imports: ImportItem[];
  native_from: string | null;
  allowance: { used: number; limit: number; resets_at: number };
  max_chunk_rows: number;
  max_chunk_bytes: number;
}

const KIND_NAMES: Record<string, string> = {
  visitors: 'daily totals',
  source: 'sources',
  campaign: 'campaigns',
  keyword: 'keywords',
  page: 'pages',
  entry_page: 'entry pages',
  exit_page: 'exit pages',
  country: 'countries',
  device: 'devices',
  browser: 'browsers',
  os: 'operating systems',
  goal: 'goals',
};

const n = (v: number) => v.toLocaleString('en');

/** Cut day-rows into requests of at most `maxRows` rows and about `maxBytes` of JSON. */
export function chunkRows(rows: DayRow[], maxRows: number, maxBytes: number): DayRow[][] {
  const out: DayRow[][] = [];
  let cur: DayRow[] = [];
  let size = 0;
  for (const r of rows) {
    const bytes = JSON.stringify(r).length + 1;
    if (cur.length && (cur.length >= maxRows || size + bytes > maxBytes * 0.9)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Settings: bring in web history from a Plausible CSV export (docs/IMPORT.md). The browser reads the files and sends daily rows. */
export function ImportHistory({ site }: { site: Site }) {
  const base = `/api/sites/${site.id}/imports`;
  const [list, setList] = useState<ImportList | null>(null);
  const [preview, setPreview] = useState<{ rows: DayRow[]; preview: ImportPreview } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [paused, setPaused] = useState<{ id: string; chunks: DayRow[][]; next: number } | null>(null);
  // An unfinished import picked up after a reload: the next file chosen continues it.
  const [resuming, setResuming] = useState<ImportItem | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = () => api<ImportList>(base).then(setList, () => undefined);
  useEffect(() => {
    load();
  }, [base]);

  async function choose(files: FileList | null) {
    setError('');
    setPreview(null);
    if (!files?.length) return;
    setBusy('Reading files');
    try {
      const texts: { name: string; text: string }[] = [];
      for (const f of Array.from(files)) {
        if (/\.zip$/i.test(f.name)) {
          for (const e of readZip(new Uint8Array(await f.arrayBuffer()))) texts.push({ name: e.name, text: await e.text() });
        } else texts.push({ name: f.name, text: await f.text() });
      }
      const r = aggregate(texts);
      const target = resuming;
      setResuming(null);
      if (!r.rows.length) setError(r.preview.warnings[0] ?? 'No rows could be read.');
      else if (target) {
        if (r.preview.from !== target.from || r.preview.to !== target.to) {
          setError(`This file covers ${r.preview.from} to ${r.preview.to}. The import to resume covers ${target.from} to ${target.to}. Choose the same export again.`);
        } else {
          // Chunks are stored whole, so the stored count lands on a chunk boundary. Anywhere else, start over: a row sent twice replaces itself.
          const chunks = chunkRows(r.rows, list?.max_chunk_rows ?? 100, list?.max_chunk_bytes ?? 400_000);
          let done = 0;
          let next = 0;
          while (next < chunks.length && done < (target.stored ?? 0)) done += chunks[next++].length;
          setBusy('');
          if (file.current) file.current.value = '';
          await send(target.id, chunks, done === (target.stored ?? 0) ? next : 0);
          return;
        }
      } else setPreview(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      if (file.current) file.current.value = '';
    }
  }

  /** Send chunks from `from` on. A refused chunk stops here and keeps the rest for Resume. */
  async function send(id: string, chunks: DayRow[][], from: number) {
    setBusy('Sending');
    setError('');
    try {
      for (let i = from; i < chunks.length; i++) {
        setBusy(`Sending ${i + 1} of ${chunks.length}`);
        try {
          await api(`${base}/${id}/rows`, { method: 'POST', json: { rows: chunks[i] } });
        } catch (e) {
          setPaused({ id, chunks, next: i });
          throw e;
        }
      }
      await api(`${base}/${id}/finish`, { method: 'POST' });
      setPaused(null);
      setPreview(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy('');
    }
  }

  async function start() {
    if (!preview || !list) return;
    const p = preview.preview;
    setBusy('Starting');
    setError('');
    try {
      const { id } = await api<{ id: string }>(base, {
        method: 'POST',
        json: {
          source: 'plausible',
          from: p.from,
          to: p.to,
          files: p.files.filter((f) => f.table).map((f) => ({ name: f.name, table: f.table, rows: f.rows })),
        },
      });
      await send(id, chunkRows(preview.rows, list.max_chunk_rows, list.max_chunk_bytes), 0);
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  }

  async function remove(i: ImportItem) {
    if (!confirm(`Delete the import of ${i.from} to ${i.to}? Its days leave the charts and panels.`)) return;
    setBusy('Deleting');
    try {
      await api(`${base}/${i.id}`, { method: 'DELETE' });
      if (paused?.id === i.id) setPaused(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const p = preview?.preview;
  const items = list?.imports ?? [];
  const left = list ? Math.max(0, list.allowance.limit - list.allowance.used) : 0;
  const daysNeeded = p && list ? Math.ceil(p.dayRows / Math.max(1, list.allowance.limit)) : 0;
  return (
    <div className="text-sm">
      {items.length === 0 && !preview && (
        <p className="rounded-xl bg-stone-50 px-3 py-3 text-stone-600">
          No imported history yet. From DataFast, use the API import below. From Plausible, open Site settings, Imports and exports, then Export data, and choose the zip here. Another tool's
          export works if it uses the same CSV files, but only Plausible's is tested. Imported days show in the chart and in the panels for the dates before this site's first visit.
        </p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200/70">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-medium">
                {i.from} to {i.to}
              </span>
              <span className="text-stone-400">{i.source === 'datafast' ? 'DataFast' : 'Plausible'}</span>
              <span className="text-stone-500">
                {i.status === 'done' ? `${n(i.rows)} day-rows` : paused?.id === i.id ? 'Paused' : i.source === 'datafast' ? `Not finished, ${n(i.stored ?? 0)} day-rows stored, not counted yet` : `Not finished, ${n(i.stored ?? 0)} day-rows stored, not counted yet`}
              </span>
              {paused?.id === i.id && (
                <button className="btn-dark ml-auto" disabled={!!busy} onClick={() => send(paused.id, paused.chunks, paused.next)}>
                  Resume
                </button>
              )}
              {i.status === 'importing' && i.source !== 'datafast' && paused?.id !== i.id && (
                <button
                  className="btn-dark ml-auto"
                  disabled={!!busy}
                  onClick={() => {
                    setResuming(i);
                    file.current?.click();
                  }}
                >
                  Resume with the same file
                </button>
              )}
              <button className={`btn ${i.status === 'importing' ? '' : 'ml-auto'}`} disabled={!!busy} onClick={() => remove(i)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {list?.native_from && items.length > 0 && (
        <p className="mt-2 text-stone-500">
          This site has its own data from {list.native_from}. Imported days from that date on are kept but not shown, so no day counts twice.
        </p>
      )}

      <div className="mt-4">
        <input ref={file} type="file" accept=".zip,.csv" multiple className="hidden" onChange={(e) => choose(e.target.files)} />
        <button className="btn" disabled={!!busy} onClick={() => {
            setResuming(null);
            file.current?.click();
          }}>
          Choose the export zip or CSV files
        </button>
        {busy && <span className="ml-3 text-stone-500">{busy}</span>}
      </div>

      {p && (
        <div className="mt-4 rounded-xl bg-stone-50 px-3 py-3">
          <div className="font-medium">
            {p.from} to {p.to}: {n(p.days)} days, {n(p.totals.visitors)} visitors, {n(p.totals.pageviews)} pageviews
          </div>
          <div className="mt-1 text-stone-600">
            Stores {n(p.dayRows)} day-rows, each one database row: {Object.entries(p.perKind)
              .map(([k, v]) => `${n(v!)} ${KIND_NAMES[k] ?? k}`)
              .join(', ')}.
          </div>
          {list?.native_from && p.to! >= list.native_from && (
            <div className="mt-1 text-stone-600">Days from {list.native_from} on are stored but not shown, because this site has its own data for them.</div>
          )}
          {p.warnings.map((w) => (
            <div key={w} className="mt-1 text-amber-700">
              {w}
            </div>
          ))}
          {list && p.dayRows > left && (
            <div className="mt-1 text-amber-700">
              The free plan leaves room for {n(list.allowance.limit)} imported rows a day, and {n(left)} are left today. This import needs {n(p.dayRows)}, so
              it stops when the allowance is used. Resume it after 00:00 UTC{daysNeeded > 1 ? `, about ${daysNeeded} days in all` : ''}.
            </div>
          )}
          <details className="mt-2 text-stone-500">
            <summary className="cursor-pointer">{p.files.length} files</summary>
            <ul className="mt-1 space-y-0.5">
              {p.files.map((f) => (
                <li key={f.name}>
                  {f.name}: {f.table ? `${n(f.rows)} rows${f.skipped ? `, ${n(f.skipped)} skipped` : ''}` : f.note}
                </li>
              ))}
            </ul>
          </details>
          <div className="mt-3 flex gap-2">
            <button className="btn-dark" disabled={!!busy} onClick={start}>
              Import {n(p.days)} days
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="mt-3 text-red-600">{error}</div>}
      <DataFastImport base={base} currency={site.currency} timezone={site.timezone} nativeFrom={list?.native_from ?? null} items={items} onChange={load} />
    </div>
  );
}
