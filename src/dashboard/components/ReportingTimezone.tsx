import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { api, isViewer, type Site } from '../lib/api';
import { SettingsCard } from './setup/kit';
import { Note, SkeletonText, toast } from './ui';

/**
 * The reporting timezone (src/worker/reporting.ts, docs/API.md "Reporting timezone"): the days Home, the iPhone, the
 * read API and the Monday report count in. Settings shows and saves it; a site page whose own timezone differs says so.
 */
export interface ReportingTz {
  timezone: string;
  source: 'setting' | 'sites' | 'default';
  saved: string | null;
  sites: { id: string; name: string; timezone: string }[];
  /** Ids of the sites whose own timezone is another one. */
  differ: string[];
}

// One fetch per page load, shared by every component that asks; a save replaces it.
let cache: Promise<ReportingTz> | null = null;
const listeners = new Set<(r: ReportingTz) => void>();
function load(): Promise<ReportingTz> {
  cache ??= api<ReportingTz>('/api/settings/reporting-timezone').catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}
function publish(r: ReportingTz) {
  cache = Promise.resolve(r);
  for (const l of listeners) l(r);
}

export function useReportingTz(): ReportingTz | null {
  const [data, setData] = useState<ReportingTz | null>(null);
  useEffect(() => {
    let alive = true;
    load().then((r) => alive && setData(r), () => undefined);
    listeners.add(setData);
    return () => {
      alive = false;
      listeners.delete(setData);
    };
  }, []);
  return data;
}

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

/** Settings, under General: the reporting timezone, and one click to move every site onto it. */
export function ReportingTimezoneSection() {
  const data = useReportingTz();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (data) setValue(data.timezone);
  }, [data?.timezone]);
  const others = useMemo(() => (data ? data.sites.filter((s) => data.differ.includes(s.id)) : []), [data]);
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!data)
    return (
      <SettingsCard id="reporting-timezone" title="Reporting timezone">
        <SkeletonText lines={2} />
      </SettingsCard>
    );
  const viewer = isViewer();

  const run = async (fn: () => Promise<ReportingTz>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      publish(await fn());
      toast(done, 'ok');
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const save = (timezone: string | null) =>
    run(() => api<ReportingTz>('/api/settings/reporting-timezone', { method: 'PUT', json: { timezone } }), timezone ? `Saved. Days now run on ${timezone} time.` : 'Saved. The timezone follows the sites again.');
  const applyAll = () => {
    if (!window.confirm(`Count days in ${data.timezone} on every site's page? ${others.map((s) => `${s.name} moves from ${s.timezone}.`).join(' ')}`)) return;
    run(() => api<ReportingTz>('/api/settings/reporting-timezone/apply', { method: 'POST' }), `Every site now counts days in ${data.timezone}.`);
  };

  const why =
    data.source === 'setting'
      ? 'You picked it.'
      : data.source === 'sites'
        ? 'Every site uses it, so FounderData picked it.'
        : 'Your sites use different timezones, so FounderData uses UTC until you pick one.';

  return (
    <SettingsCard
      id="reporting-timezone"
      title="Reporting timezone"
      desc="Home, the iPhone app, the read API and the Monday report count days in this timezone. It covers every site, so they show the same numbers for the same period."
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <label className="label" htmlFor="reporting-tz">
            Timezone
          </label>
          <input
            id="reporting-tz"
            className="input"
            list="reporting-tz-list"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={viewer}
            spellCheck={false}
          />
          <datalist id="reporting-tz-list">
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        {!viewer && (
          <>
            <button className="btn-dark" disabled={busy || !value.trim() || value.trim() === data.saved} onClick={() => save(value.trim())}>
              Save
            </button>
            {browser && browser !== value && (
              <button className="btn" disabled={busy} onClick={() => setValue(browser)}>
                Use {browser}
              </button>
            )}
            {data.saved && (
              <button className="btn" disabled={busy} onClick={() => save(null)}>
                Follow the sites
              </button>
            )}
          </>
        )}
      </div>
      <p className="mt-2 text-[13px] text-stone-500">
        Now {data.timezone}. {why}
      </p>
      {others.length > 0 && (
        <div className="card-inset mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <Note
            className="min-w-0 flex-1 basis-64"
            more={
              <p>
                {others.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ', '}
                    <span className="font-medium text-ink">{s.name}</span> {s.timezone}
                  </span>
                ))}
                . Totals on those pages can differ from Home by a few hours of data.
              </p>
            }
          >
            {others.length === 1 ? '1 site counts' : `${others.length} sites count`} days in another timezone on its own page.
          </Note>
          {!viewer && (
            <button className="btn" disabled={busy} onClick={applyAll}>
              Use {data.timezone} for every site
            </button>
          )}
        </div>
      )}
      {msg?.error && <p className="mt-3 text-sm text-red-600">{msg.text}</p>}
    </SettingsCard>
  );
}

/**
 * A line on a site's page when its timezone is not the reporting one: the same period then covers other hours than
 * Home, the iPhone and the read API, so the totals can differ. Renders nothing when the two match.
 */
export function SiteTimezoneNote({ site }: { site: Pick<Site, 'id' | 'timezone'> }) {
  const data = useReportingTz();
  if (!data || data.timezone === site.timezone) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
      <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-600">Days in {site.timezone}</span>
      <span>Home and the iPhone count in {data.timezone}, so totals there can differ from this page.</span>
      {!isViewer() && (
        <button className="underline underline-offset-2 hover:text-ink" onClick={() => navigate(`/site/${site.id}/settings#reporting-timezone`)}>
          Match them
        </button>
      )}
    </p>
  );
}
