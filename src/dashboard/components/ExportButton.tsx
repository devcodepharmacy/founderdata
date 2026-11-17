import { useState } from 'react';
import { fmtNumber } from '../lib/format';
import { Spinner } from './ui/Spinner';

/** Pages a CSV export holds at most when the dashboard follows its Link headers (5,000 rows each). */
const MAX_PAGES = 200;

/** The next page of a CSV export, from its Link header. */
function nextUrl(res: Response): string | null {
  const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
  return m ? m[1] : null;
}

/**
 * Downloads a CSV route (docs/API.md, "CSV export"). A big export comes in several responses; this follows each
 * Link header and saves one file.
 */
export function ExportButton({ url, className, label = 'Export CSV' }: { url: string; className?: string; label?: string }) {
  const [state, setState] = useState<{ rows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setState({ rows: 0 });
    try {
      const parts: string[] = [];
      let name = 'export.csv';
      let rows = 0;
      let next: string | null = url;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const res: Response = await fetch(next, { credentials: 'same-origin' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? res.statusText);
        }
        if (page === 0) name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? name;
        parts.push(await res.text());
        rows += Number(res.headers.get('x-rows') ?? 0);
        setState({ rows });
        next = nextUrl(res);
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setState(null);
    }
  };

  return (
    <button
      className={className ?? 'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink disabled:cursor-progress disabled:opacity-70'}
      onClick={run}
      disabled={!!state}
      title={error ?? 'Download as CSV, with the period and filters you see'}
    >
      {state ? (
        <Spinner size={12} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
        </svg>
      )}
      <span className={error && !state ? 'text-red-600' : ''}>{state ? (state.rows ? `${fmtNumber(state.rows)} rows` : 'Exporting') : error ? 'Export failed, try again' : label}</span>
    </button>
  );
}
