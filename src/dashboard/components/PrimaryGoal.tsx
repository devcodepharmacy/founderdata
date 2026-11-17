import { useEffect, useState } from 'react';
import { api, type Site } from '../lib/api';
import { fmtNumber } from '../lib/format';
import { ErrorLine, GoalIcon } from './site/primitives';
import { SetupRow } from './ui/SetupRow';
import { SettingsCard } from './setup/kit';
import { Skeleton } from './ui/Skeleton';
import { Spinner } from './ui/Spinner';

/** GET /api/sites/:id/goal (src/worker/primary-goal.ts). */
interface GoalData {
  name: string | null;
  label: string | null;
  custom_label: string | null;
  days: number;
  options: { name: string; visitors: number }[];
}

/** "newsletter_signup" as "Newsletter signup", as the server words it (goalWords in src/worker/primary-goal.ts). */
const words = (name: string) => {
  const s = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
};

/**
 * Settings, "Primary goal": one of the site's goal names, counted on Home, in the Content tab, the portfolio and the
 * weekly report (docs/GUIDE.md, "Primary goal"). A site without revenue shows it as its headline number.
 */
export function PrimaryGoalSection({ site, onSaved }: { site: Site; onSaved?: (name: string | null, label: string | null) => void }) {
  const [data, setData] = useState<GoalData | null>(null);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: string }>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    setLoadError(null);
    api<GoalData>(`/api/sites/${site.id}/goal`).then((d) => {
      setData(d);
      setName(d.name ?? '');
      setLabel(d.custom_label ?? '');
    }, (e) => setLoadError((e as Error).message));
  }, [site.id, tries]);

  async function save(next: string) {
    setState({ busy: true });
    try {
      const d = await api<{ name: string | null; label: string | null; custom_label: string | null }>(`/api/sites/${site.id}/goal`, {
        method: 'PUT',
        json: { name: next || null, label: label.trim() || null },
      });
      setData((old) => (old ? { ...old, ...d } : old));
      setName(d.name ?? '');
      setLabel(d.custom_label ?? '');
      setState({ msg: d.name ? `Saved. Home shows ${d.label}.` : 'Primary goal removed.' });
      onSaved?.(d.name, d.custom_label);
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }

  const options = data?.options ?? [];
  // The saved goal stays in the list even when it sent nothing in the last 90 days.
  const listed = data?.name && !options.some((o) => o.name === data.name) ? [{ name: data.name, visitors: 0 }, ...options] : options;
  const changed = !!data && (name !== (data.name ?? '') || (label.trim() || null) !== (data.custom_label ?? null));

  return (
    <SettingsCard
      id="primary-goal"
      title="Primary goal"
      desc="The goal Home, the weekly report and the Content tab count for this site. A site without revenue shows it as its main number."
    >
      {!data && loadError ? (
        <ErrorLine error={loadError} retry={() => setTries((t) => t + 1)} />
      ) : !data ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" role="status" aria-busy="true">
          <span className="sr-only">Loading</span>
          {[0, 1].map((i) => (
            <div key={i}>
              <Skeleton className="mb-2 h-3.5 w-16" />
              <Skeleton className="h-[42px] w-full rounded-[10px]" />
            </div>
          ))}
          <Skeleton className="h-[42px] w-20 rounded-[10px]" />
        </div>
      ) : listed.length === 0 ? (
        <SetupRow icon={<GoalIcon size={18} />} title={`No goals in the last ${data.days} days`}>
          Put <code className="rounded bg-stone-100 px-1 text-[12px]">data-rt-goal="signup"</code> on a button, then pick it here.
        </SetupRow>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="primary-goal-name">
              Goal
            </label>
            <select id="primary-goal-name" className="input" value={name} onChange={(e) => setName(e.target.value)}>
              <option value="">None</option>
              {listed.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name} ({fmtNumber(o.visitors)} {o.visitors === 1 ? 'visitor' : 'visitors'})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="primary-goal-label">
              Show as
            </label>
            <input
              id="primary-goal-label"
              className="input"
              maxLength={40}
              disabled={!name}
              placeholder={name ? words(name) : 'Pick a goal first'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button className="btn-dark h-[42px]" disabled={!changed || state.busy} onClick={() => save(name)}>
            {state.busy ? (
              <>
                <Spinner /> Saving
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
      )}
      {data && listed.length > 0 && (
        <p className="mt-3 text-[13px] text-stone-500">Counts visitors once each. The list shows the last {data.days} days, most visitors first.</p>
      )}
      {(state.msg || state.error) && <p className={`mt-2 text-[13px] ${state.error ? 'text-red-600' : 'text-emerald-700'}`} role={state.error ? 'alert' : 'status'}>{state.error ?? state.msg}</p>}
    </SettingsCard>
  );
}
