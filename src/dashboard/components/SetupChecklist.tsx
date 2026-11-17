import { useState } from 'react';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { useApi } from '../lib/useApi';
import { CheckResult, CopyButton, InlineError } from './setup/kit';
import { SkeletonRows, Spinner, StatusChip, type StatusTone } from './ui';

// The setup checklist (src/worker/setup-checklist.ts, docs/GUIDE.md "Setup checklist"): one row per integration with its
// live status and the next step. Loading the rows calls nobody. A test runs only when its button is pressed. Only the
// owner sees it; secrets appear by name and never by value. It reads as progress: what needs a look first, with the one
// next action, then what works, then what is optional and off.

const DOCS = 'https://github.com/datPascal/founderdata/blob/main/';

interface Row {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'off';
  detail: string;
  next: string | null;
  guide: string;
  copy?: string;
  test?: 'dataforseo' | 'x';
  secrets?: { name: string; set: boolean }[];
  last_test?: { ok: boolean; at: number; message: string } | null;
  site?: { id: string; name: string };
}

const BADGE: Record<Row['status'], { text: string; tone: StatusTone }> = {
  ok: { text: 'Working', tone: 'ok' },
  warn: { text: 'Needs a look', tone: 'warn' },
  error: { text: 'Broken', tone: 'error' },
  off: { text: 'Off', tone: 'neutral' },
};

function RowView({ row, reload, lead }: { row: Row; reload: () => void; lead?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState(!!lead);
  const run = async () => {
    if (!row.test) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await api(`/api/setup/test/${row.test}`, { method: 'POST' }));
      reload();
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const b = BADGE[row.status];
  const body = `check-${row.id.replace(/[^\w-]/g, '-')}`;
  return (
    <li className={lead ? 'rounded-xl bg-stone-50 px-3.5 py-3 ring-1 ring-inset ring-stone-200/70' : 'py-1'}>
      <button type="button" className="flex w-full items-center gap-2.5 rounded-lg py-1.5 text-left" aria-expanded={open} aria-controls={body} onClick={() => setOpen((o) => !o)}>
        <StatusChip tone={b.tone}>{b.text}</StatusChip>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {row.label}
          {row.site && <span className="font-normal text-stone-500"> · {row.site.name}</span>}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-stone-400 transition-transform duration-base ${open ? 'rotate-180' : ''}`} aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={body} className="pb-2 pl-1 pt-1 text-sm animate-fade">
          <p className="text-stone-600">{row.detail}</p>
          {row.next && (
            <p className="mt-1.5 text-ink">
              <span className="font-medium">Next: </span>
              {row.next}
            </p>
          )}
          {row.secrets && (
            <p className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {row.secrets.map((s) => (
                <StatusChip key={s.name} tone={s.set ? 'ok' : 'neutral'} className="font-mono">
                  {s.name} {s.set ? 'set' : 'not set'}
                </StatusChip>
              ))}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {row.copy && <CopyButton value={row.copy} label={row.id === 'google' ? 'Copy redirect URI' : 'Copy'} className="btn h-8" />}
            {row.test && (
              <button className="btn h-8" disabled={busy} onClick={run}>
                {busy ? (
                  <>
                    <Spinner /> Testing
                  </>
                ) : (
                  'Test'
                )}
              </button>
            )}
            <a className="btn-ghost h-8" href={DOCS + row.guide} target="_blank" rel="noreferrer">
              Read the guide
            </a>
          </div>
          {result && (
            <div className="mt-2.5">
              <CheckResult ok={result.ok} title={result.ok ? 'The test passed' : 'The test failed'}>
                {result.message}
              </CheckResult>
            </div>
          )}
          {!result && row.last_test && (
            <p className={`mt-2 text-xs ${row.last_test.ok ? 'text-stone-500' : 'text-red-600'}`}>
              Last test {fmtAgo(Math.max(0, Date.now() - row.last_test.at))} ago: {row.last_test.message}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function SetupChecklist() {
  const [reload, setReload] = useState(0);
  const { data, error } = useApi<{ rows: Row[] }>('/api/setup', reload);
  const again = () => setReload((n) => n + 1);
  if (error && !data) return <InlineError message={error} onRetry={again} />;
  if (!data) return <SkeletonRows rows={4} />;
  const rows = data.rows;
  const look = rows.filter((r) => r.status === 'error' || r.status === 'warn').sort((a, b) => Number(a.status === 'warn') - Number(b.status === 'warn'));
  const ok = rows.filter((r) => r.status === 'ok');
  const off = rows.filter((r) => r.status === 'off');
  const share = (n: number) => `${(n / Math.max(1, rows.length)) * 100}%`;
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-ink">
            {ok.length} of {rows.length} working
          </span>
          <span className="text-xs text-stone-500">
            {look.length ? `${look.length} need a look · ` : ''}
            {off.length} optional, off
          </span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-stone-100" aria-hidden="true">
          <span className="bg-emerald-500" style={{ width: share(ok.length) }} />
          <span className="bg-red-500" style={{ width: share(look.filter((r) => r.status === 'error').length) }} />
          <span className="bg-amber-400" style={{ width: share(look.filter((r) => r.status === 'warn').length) }} />
        </div>
        <p className="mt-2 text-xs text-stone-500">Each test runs only when you press it. Wait 15 seconds between presses.</p>
      </div>

      {look.length > 0 && (
        <section aria-label="Needs a look">
          <h4 className="mb-2 text-micro uppercase text-stone-400">Needs a look</h4>
          <ul className="space-y-2">
            {look.map((r, i) => (
              <RowView key={r.id} row={r} reload={again} lead={i === 0} />
            ))}
          </ul>
        </section>
      )}
      {ok.length > 0 && (
        <section aria-label="Working">
          <h4 className="mb-1 text-micro uppercase text-stone-400">Working</h4>
          <ul className="divide-y divide-stone-200/60">
            {ok.map((r) => (
              <RowView key={r.id} row={r} reload={again} />
            ))}
          </ul>
        </section>
      )}
      {off.length > 0 && (
        <section aria-label="Optional, off">
          <h4 className="mb-1 text-micro uppercase text-stone-400">Optional, off</h4>
          <ul className="divide-y divide-stone-200/60">
            {off.map((r) => (
              <RowView key={r.id} row={r} reload={again} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
