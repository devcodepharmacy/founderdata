import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { estimateCalls, lastDay, planRevenue, runDataFastImport, type ApiAnswer, type Granularity, type Plan, type Progress, type RevenueChoice } from '../../shared/datafast-import';
import { SecretInput } from './setup/kit';
import { Note } from './ui';

interface Item {
  id: string;
  source: string;
  status: 'importing' | 'done';
  from: string;
  to: string;
  files?: { name: string }[];
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const decimalsOf = (currency: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};
const mmss = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/**
 * Settings, Import history: bring in a DataFast site through its API (docs/GUIDE.md "Import from DataFast"). The browser
 * pages through the API at 60 calls a minute and sends day-rows to the import routes. The key goes to DataFast, directly
 * or through one forwarding route of this Worker when DataFast blocks browser calls, and it is never stored.
 */
export function DataFastImport({
  base,
  currency,
  timezone,
  nativeFrom,
  items,
  onChange,
}: {
  base: string;
  currency: string;
  timezone: string;
  nativeFrom: string | null;
  items: Item[];
  onChange: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [from, setFrom] = useState(day(-365 * 3));
  const [to, setTo] = useState(nativeFrom ? new Date(Date.parse(nativeFrom + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10) : day(-1));
  const [g, setG] = useState<Granularity>('week');
  const [unit, setUnit] = useState<RevenueChoice['unit']>('');
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stop = useRef({ aborted: false });
  const proxy = useRef(false);

  // The import stops the day before the site's first own day, so the estimate counts to there.
  const end = lastDay({ to, nativeFrom });
  const clipped = end < to;
  const valid = /^dft?_[\w-]{8,200}$/.test(key.trim()) && from <= end;
  const daily = estimateCalls(from, end < from ? from : end, 'day');
  const weekly = estimateCalls(from, end < from ? from : end, 'week');
  const unfinished = items.filter((i) => i.source === 'datafast' && i.status === 'importing');

  /** One DataFast read: directly from the browser, or through the Worker once a direct call fails (CORS). */
  async function get(path: string, query: Record<string, string>): Promise<ApiAnswer> {
    const q = { ...query, ...(websiteId.trim() ? { websiteId: websiteId.trim() } : {}) };
    if (!proxy.current) {
      try {
        const res = await fetch(`https://datafa.st/api/v1/${path}?${new URLSearchParams(q)}`, { headers: { Authorization: `Bearer ${key.trim()}` } });
        return { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || null, body: await res.json().catch(() => null) };
      } catch {
        proxy.current = true;
      }
    }
    const r = await api<{ status: number; retry_after: number | null; body: any }>(`${base}/datafast/get`, { method: 'POST', json: { key: key.trim(), path, query: q } });
    return { status: r.status, retryAfter: r.retry_after, body: r.body };
  }

  async function run(id: string, plan: Plan, done: Set<string>) {
    stop.current = { aborted: false };
    setBusy(true);
    setError('');
    try {
      await runDataFastImport(plan, {
        get,
        done,
        signal: stop.current,
        onProgress: setProgress,
        send: async (rows) => {
          await api(`${base}/${id}/rows`, { method: 'POST', json: { rows } });
        },
      });
      await api(`${base}/${id}/finish`, { method: 'POST' });
      setOpen(false);
      setKey('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await onChange();
    }
  }

  async function planFor(fromDay: string, toDay: string, granularity: Granularity): Promise<Plan> {
    // The website's currency decides whether its revenue can be added, and revenue needs a unit the person chose.
    const meta = await get('analytics/metadata', {});
    if (meta.status === 401 || meta.status === 403) throw new Error('DataFast refused the key. Use a website key (df_) or an account token (dft_) that can read analytics.');
    const r = planRevenue(meta.body, { currency, timezone, decimals: decimalsOf(currency) }, { unit, currencyConfirmed: confirmed });
    setNotice(r.notes.join(' '));
    if (r.blocked) throw new Error(r.blocked);
    return { from: fromDay, to: toDay, nativeFrom, granularity, revenue: r.revenue };
  }

  async function start() {
    setError('');
    setBusy(true);
    try {
      const plan = await planFor(from, to, g);
      const { id } = await api<{ id: string }>(base, {
        method: 'POST',
        json: { source: 'datafast', from, to, files: [{ name: `DataFast API, ${g === 'day' ? 'daily' : 'weekly'} breakdowns` }] },
      });
      await run(id, plan, new Set());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function resume(i: Item) {
    if (!valid && !/^dft?_[\w-]{8,200}$/.test(key.trim())) return setError('Paste the DataFast key to resume. It is not stored, so it is asked for again.');
    setError('');
    setBusy(true);
    try {
      const granularity: Granularity = i.files?.[0]?.name.includes('daily') ? 'day' : 'week';
      const plan = await planFor(i.from, i.to, granularity);
      const { keys } = await api<{ keys: string[] }>(`${base}/${i.id}/progress`);
      await run(i.id, plan, new Set(keys));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="mt-6 border-t border-stone-200/60 pt-5 text-sm">
      <div className="text-[13px] font-semibold text-ink">Import from DataFast</div>
      <Note
        className="mt-1"
        more={
          <p>
            DataFast has no export file, so this page reads its API with your key. The key goes to DataFast, directly or through your Worker if the browser is blocked. Imported days
            show before this site's first own visit, and filtering by a source answers from them.
          </p>
        }
      >
        Reads the DataFast API with your key. The key is never stored.
      </Note>
      {unfinished.map((i) => (
        <div key={i.id} className="card-inset mt-2 flex flex-wrap items-center gap-2 px-3 py-2">
          <span>
            Not finished: {i.from} to {i.to}
          </span>
          <SecretInput className="w-56" label="DataFast key to resume" placeholder="DataFast key to resume" value={key} onChange={setKey} />
          <button className="btn-dark" disabled={busy} onClick={() => resume(i)}>
            Resume
          </button>
        </div>
      ))}
      {!open && (
        <button className="btn mt-3" disabled={busy} onClick={() => setOpen(true)}>
          Import from DataFast
        </button>
      )}
      {open && (
        <div className="card-inset mt-3 grid max-w-xl gap-3 p-4">
          <SecretInput className="w-full" label="DataFast API key or account token" placeholder="DataFast API key (df_...) or account token (dft_...)" value={key} onChange={setKey} />
          <input className="input" placeholder="Website id (only for a dft_ account token)" value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-stone-500">From</label>
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label className="text-stone-500">to</label>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <fieldset className="grid gap-1">
            <label className="flex items-start gap-2">
              <input type="radio" checked={g === 'week'} onChange={() => setG('week')} className="mt-1" />
              <span>
                <b>Weekly breakdowns</b>, up to {weekly.calls.toLocaleString('en')} calls, about {weekly.minutes} min.
                <span className="block text-xs text-stone-500">Stored per week. Day totals and the chart stay daily.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" checked={g === 'day'} onChange={() => setG('day')} className="mt-1" />
              <span>
                <b>Daily breakdowns</b>, up to {daily.calls.toLocaleString('en')} calls, about {mmss(daily.minutes * 60)}.
                <span className="block text-xs text-stone-500">Exact for any date range and a filtered chart. Slower.</span>
              </span>
            </label>
          </fieldset>
          <Note
            more={
              <>
                <p>A date range that starts inside a week leaves that week out; one that ends inside a week counts all of it.</p>
                <p>DataFast allows 60 calls a minute, and days with no visitors are skipped. Visitors are summed per day.</p>
              </>
            }
          >
            Weekly is faster, daily is exact.
          </Note>
          {clipped && (
            <Note>This site's own data starts {nativeFrom}, so the import stops on {end}.</Note>
          )}
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-stone-500">DataFast writes revenue as</span>
            <select className="input w-auto" value={unit} onChange={(e) => setUnit(e.target.value as RevenueChoice['unit'])}>
              <option value="">Choose one</option>
              <option value="major">whole currency units (49 means 49.00)</option>
              <option value="minor">cents (4900 means 49.00)</option>
              <option value="none">leave revenue out</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-stone-600">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
            <span>DataFast's revenue is in {currency}. Needed only when DataFast does not report its currency.</span>
          </label>
          <Note
            more={
              <p>
                It shows next to the imported days, labelled, and never joins this site's own revenue, customers or conversion. Compare one source's revenue with your DataFast
                dashboard after the import, and delete and redo it if the unit was wrong.
              </p>
            }
          >
            Revenue is stored as imported revenue per source and day.
          </Note>
          <div className="flex gap-2">
            <button className="btn-dark" disabled={!valid || busy || !unit} onClick={start}>
              Start import
            </button>
            <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy && progress && (
        <div className="mt-3 max-w-xl">
          <div className="h-2 overflow-hidden rounded-full bg-stone-100">
            <div className="h-full bg-visitors" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-stone-600">
            {progress.message}: {progress.done.toLocaleString('en')} of {progress.total.toLocaleString('en')} {g === 'day' ? 'days' : 'weeks'}, {progress.calls.toLocaleString('en')} calls
            {progress.etaSeconds ? `, about ${mmss(progress.etaSeconds)} left` : ''}. Keep this page open; Resume continues after a reload.
          </div>
          <button className="btn mt-2" onClick={() => (stop.current.aborted = true)}>
            Stop
          </button>
        </div>
      )}
      {notice && <div className="mt-3 text-amber-700">{notice}</div>}
      {error && <div className="mt-3 text-red-600">{error}</div>}
    </div>
  );
}
