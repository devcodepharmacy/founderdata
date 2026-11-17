import { useEffect, useId, useState } from 'react';
import { navigate } from '../../App';
import { api, type Erasure, type Site } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { fmtAgo, fmtDateTime } from '../../lib/format';
import { isAppOnly } from '../../lib/siteKind';
import { Code } from '../Code';
import { EmptyState, EmptyIcons, SkeletonRows, Spinner, StatusChip, toast } from '../ui';
import { CopyField, InlineError, SettingsCard } from './kit';
import { useCardStatus, useSetup } from './status';
import type { Save } from './Payments';

/** Name, domain, timezone, currency and bundle id, saved together. */
export function GeneralCard({ site, save }: { site: Site; save: Save }) {
  const appOnly = isAppOnly(site);
  const [form, setForm] = useState({
    name: site.name,
    domain: appOnly ? '' : site.domain,
    timezone: site.timezone,
    currency: site.currency,
    bundle: site.app_bundle_id ?? '',
    appStoreId: site.app_store_id ?? '',
  });
  const [addDomain, setAddDomain] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const showDomain = !appOnly || addDomain;
  const ids = { name: useId(), domain: useId(), tz: useId(), cur: useId(), bundle: useId(), store: useId() };
  return (
    <SettingsCard id="general" title="General" desc="How the site is named and counted. The timezone sets where each day starts on this site's pages.">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await save({
            name: form.name,
            timezone: form.timezone,
            currency: form.currency,
            app_bundle_id: form.bundle.trim() || null,
            ...(form.bundle.trim() ? { app_store_id: form.appStoreId.trim() || null } : {}),
            ...(showDomain && form.domain.trim() ? { domain: form.domain } : {}),
          });
          setBusy(false);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={ids.name}>
              Name
            </label>
            <input id={ids.name} className="input" value={form.name} onChange={set('name')} />
          </div>
          <div>
            <label className="label" htmlFor={ids.domain}>
              Website domain
            </label>
            {showDomain ? (
              <input id={ids.domain} className="input" placeholder="example.com" value={form.domain} onChange={set('domain')} autoFocus={addDomain} />
            ) : (
              <div className="flex h-[38px] items-center gap-3 text-sm text-stone-500">
                None, this is an iOS app.
                <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={() => setAddDomain(true)}>
                  Add a website
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="label" htmlFor={ids.tz}>
              Timezone
            </label>
            <input id={ids.tz} className="input" value={form.timezone} onChange={set('timezone')} />
          </div>
          <div>
            <label className="label" htmlFor={ids.cur}>
              Revenue currency
            </label>
            <input id={ids.cur} className="input" value={form.currency} maxLength={3} onChange={set('currency')} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor={ids.bundle}>
              iOS app bundle id
            </label>
            <input id={ids.bundle} className="input font-mono" placeholder="com.example.app" value={form.bundle} onChange={set('bundle')} spellCheck={false} />
            <p className="mt-1.5 text-xs text-stone-500">The server takes app events and Apple notifications only from this bundle id. Leave it empty for a website without an app.</p>
          </div>
          {(site.app_bundle_id || form.bundle.trim()) && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor={ids.store}>
                App Store id
              </label>
              <input
                id={ids.store}
                className="input font-mono"
                placeholder={site.asc_app_id ?? '123456789'}
                value={form.appStoreId}
                onChange={set('appStoreId')}
                inputMode="numeric"
                spellCheck={false}
              />
              <p className="mt-1.5 text-xs text-stone-500">
                {site.asc_app_id
                  ? `The App Store sales import found ${site.asc_app_id}. Leave this empty unless that is wrong.`
                  : "The number in the app's App Store link, apps.apple.com/app/id123456789. Apple Search Ads and ASO use it to find the app. The App Store sales import fills it in on its own."}
              </p>
            </div>
          )}
        </div>
        <button className="btn-dark mt-5" disabled={busy}>
          {busy ? (
            <>
              <Spinner /> Saving
            </>
          ) : (
            'Save changes'
          )}
        </button>
      </form>
    </SettingsCard>
  );
}

const PRESETS = [
  { label: 'X / Twitter', source: 'x', medium: 'social' },
  { label: 'LinkedIn', source: 'linkedin', medium: 'social' },
  { label: 'Reddit', source: 'reddit', medium: 'social' },
  { label: 'YouTube', source: 'youtube', medium: 'video' },
  { label: 'Medium', source: 'medium', medium: 'article' },
  { label: 'Newsletter', source: 'newsletter', medium: 'email' },
  { label: 'Product Hunt', source: 'producthunt', medium: 'referral' },
];

/** Build a tagged link per post or article, so each one shows up by name in Campaign. */
export function LinkBuilderCard({ domain }: { domain: string }) {
  const [url, setUrl] = useState(`https://${domain}/`);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [campaign, setCampaign] = useState('');
  const ids = { page: useId(), where: useId(), name: useId() };
  let built = '';
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', preset.source);
    u.searchParams.set('utm_medium', preset.medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign.trim().toLowerCase().replace(/\s+/g, '-'));
    built = u.toString();
  } catch {}
  return (
    <SettingsCard
      id="link-builder"
      title="Link builder"
      desc="X, Medium and others hide which post sent a visitor. Put a tagged link in each post and it shows up by name under Campaign, with the revenue it made."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <label className="label" htmlFor={ids.page}>
            Page
          </label>
          <input id={ids.page} className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={ids.where}>
            Where you post it
          </label>
          <select id={ids.where} className="input" value={preset.label} onChange={(e) => setPreset(PRESETS.find((p) => p.label === e.target.value)!)}>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={ids.name}>
            Post name (campaign)
          </label>
          <input id={ids.name} className="input" placeholder="launch-tweet" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        </div>
      </div>
      {built && (
        <div className="mt-4">
          <Code>{built}</Code>
        </div>
      )}
      <p className="mt-2 text-xs text-stone-500">
        Shorter: <code>?ref=launch-tweet</code> works too and shows up as the referrer.
      </p>
    </SettingsCard>
  );
}

/** The daily write cap (src/worker/budget.ts): on by default, automatic (a pool shared by all automatic sites) unless a number is set. */
export function WriteCapCard({ site, save }: { site: Site; save: Save }) {
  const [cap, setCap] = useState(site.write_cap ? String(site.write_cap) : '');
  const on = site.write_cap_on !== 0;
  const usage = site.usage;
  const status = useCardStatus('write-cap', site);
  // Whole numbers here: 80,000 rather than 80k, so the cap and today's count can be compared.
  const rows = (n: number) => n.toLocaleString('en');
  const pct = (n: number, of: number) => Math.min(100, Math.round((n / Math.max(1, of)) * 100));
  const used = usage ? (usage.shared && usage.pool_rows !== undefined ? pct(usage.pool_rows, usage.auto) : usage.cap !== null ? pct(usage.rows, usage.cap) : null) : null;
  return (
    <SettingsCard
      id="write-cap"
      title="Daily write cap"
      status={status}
      desc="Anyone who can read the site id in your script tag or app can send events to this site. The cap keeps fake traffic from using up Cloudflare's free plan for the day or running up a Workers Paid bill."
    >
      {usage && (
        <div className="mb-5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium text-ink">Today</span>
            {used !== null && <span className="tabular-nums text-stone-500">{used}%</span>}
          </div>
          {used !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100" aria-hidden="true">
              <div className={`h-full origin-left rounded-full ${used >= 100 ? 'bg-red-500' : used >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ transform: `scaleX(${used / 100})` }} />
            </div>
          )}
          <p className="mt-2 text-[13px] text-stone-600">
            {usage.shared && usage.pool_rows !== undefined ? (
              <>
                This site wrote {rows(usage.rows)} rows. All sites wrote {rows(usage.pool_rows)} of the {rows(usage.auto)} shared rows.
                {usage.site_max ? ` This site can use up to ${rows(usage.site_max)} of them.` : ''}
                {usage.capped_at ? ` The shared rows ran out at ${fmtDateTime(usage.capped_at, site.timezone)}.` : ''}
              </>
            ) : usage.cap !== null ? (
              <>
                {rows(usage.rows)} of {rows(usage.cap)} rows.
                {usage.capped_at ? ` Cap reached at ${fmtDateTime(usage.capped_at, site.timezone)}.` : ''}
              </>
            ) : (
              <>{rows(usage.rows)} rows.</>
            )}{' '}
            The count resets at 00:00 UTC.
          </p>
        </div>
      )}
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-1" checked={on} onChange={(e) => save({ write_cap_on: e.target.checked ? 1 : 0 }, e.target.checked ? 'Write cap on' : 'Write cap off')} />
        <span>
          <span className="font-medium text-ink">Limit the rows this site writes per day</span>
          <span className="mt-0.5 block text-[13px] text-stone-500">
            At the cap, website events are dropped, and the iPhone app holds its events on the phone and sends them after the reset at 00:00 UTC. Payments from
            webhooks are always recorded.
          </span>
        </span>
      </label>
      {on && (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save({ write_cap: cap ? Number(cap) : null }, cap ? 'Cap saved' : 'Cap set to automatic');
          }}
        >
          <label className="label" htmlFor="write-cap-rows">
            Rows a day
          </label>
          <div className="flex max-w-md gap-2">
            <input
              id="write-cap-rows"
              className="input"
              inputMode="numeric"
              placeholder={`Automatic: shared ${rows(usage?.auto ?? 80_000)}`}
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <button className="btn-dark">Save</button>
          </div>
          <p className="mt-2 text-[13px] text-stone-500">
            Leave it empty for the automatic cap. Sites on automatic share {rows(usage?.auto ?? 80_000)} rows a day, 80% of the free plan, so a busy site can use what
            quiet sites leave. With more than one site, one site on automatic stops at half of them. Sites with their own number, or with the cap off, count toward the
            same rows. A website visit writes about 32 rows and an app session about 36. On Workers Paid, set the number you're willing to pay for.
          </p>
        </form>
      )}
      <div className="mt-5 border-t border-stone-200/60 pt-4">
        <label className="label" htmlFor="vitals-sample">
          Page speed samples
        </label>
        <select
          id="vitals-sample"
          className="input max-w-xs"
          value={String(site.vitals_sample ?? 100)}
          onChange={(e) => save({ vitals_sample: Number(e.target.value) }, Number(e.target.value) ? 'Page speed sample saved' : 'Page speed off')}
        >
          {[100, 50, 25, 10, 0].map((n) => (
            <option key={n} value={n}>
              {n ? `${n}% of page loads` : 'Off'}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[13px] text-stone-500">
          The tracker measures how fast each page loads in the visitor's browser. Each stored load writes 1 row. Keep 100% unless the site gets thousands of page
          loads a day. At a lower share, a page takes more visits to reach the 20 loads behind a p75.
        </p>
      </div>
    </SettingsCard>
  );
}

/** Visits from hosting networks (src/worker/datacenter.ts): hidden from the numbers unless the owner shows them. */
export function DatacenterCard({ site, save }: { site: Site; save: Save }) {
  const status = useCardStatus('datacenter', site);
  const n = site.datacenter_visits ?? 0;
  return (
    <SettingsCard
      id="datacenter"
      title="Datacenter visits"
      status={status}
      desc="A browser that runs on a cloud server is almost always a bot: an uptime check, a scraper or an AI agent. FounderData tags visits from AWS, Google Cloud, Azure, Hetzner and 10 other hosting networks. Visitor counts, pages, funnels and alerts leave them out. The CSV export keeps them."
    >
      <p className="mb-4 text-[13px] text-stone-600">
        {n ? `${n.toLocaleString('en')} ${n === 1 ? 'visit' : 'visits'} from hosting networks in the last 30 days.` : 'No visits from hosting networks in the last 30 days.'}
      </p>
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={site.show_datacenter === 1}
          onChange={(e) => save({ show_datacenter: e.target.checked ? 1 : 0 }, e.target.checked ? 'Datacenter visits counted' : 'Datacenter visits hidden')}
        />
        <span>
          <span className="font-medium text-ink">Count datacenter visits</span>
          <span className="mt-0.5 block text-[13px] text-stone-500">
            Turn this on if real people reach the site through a cloud server, such as a company VPN. Payments always count. The tag stays on each visit, so you can
            turn it off again.
          </span>
        </span>
      </label>
    </SettingsCard>
  );
}

const ERASE_METHOD: Record<Erasure['method'], string> = {
  visitor: 'One visitor',
  email: 'By email',
  user_id: 'By user id',
  'email+user_id': 'By email and user id',
};
const ERASE_KINDS: [string, string, string][] = [
  ['visitors', 'visitor', 'visitors'],
  ['sessions', 'visit', 'visits'],
  ['events', 'event', 'events'],
  ['claims', 'payment claim', 'payment claims'],
  ['signals', 'subscription signal', 'subscription signals'],
  ['payments', 'payment unlinked', 'payments unlinked'],
  ['subscriptions', 'subscription unlinked', 'subscriptions unlinked'],
];

/** Each erase request, newest first, with what it removed. The log keeps no visitor id, email or user id. */
export function ErasuresCard({ site }: { site: Site }) {
  const [n, setN] = useState(0);
  const { data, error } = useApi<Erasure[]>(`/api/sites/${site.id}/erasures`, n);
  return (
    <SettingsCard
      id="erase-log"
      title="Erase log"
      desc="One line per erase request: when, how the person was found, who handled it and how many rows went. It stores no visitor id, email or user id, so you can show when you answered a request without keeping the person. Deleting the site keeps its erase log."
      actions={
        !!data?.length && (
          <a className="btn" href={`/api/sites/${site.id}/erasures?format=csv`} download>
            Export CSV
          </a>
        )
      }
    >
      {error && <InlineError message={error} onRetry={() => setN((x) => x + 1)} />}
      {!data && !error && <SkeletonRows rows={2} />}
      {data && !data.length && (
        <EmptyState compact icon={EmptyIcons.inbox} title="No erase requests yet">
          Erase a person from their profile, or with POST /api/sites/:id/erase.
        </EmptyState>
      )}
      {!!data?.length && (
        <ul className="divide-y divide-stone-200/60">
          {data.map((e) => (
            <li key={`${e.ts}-${e.method}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
              <span className="font-medium">
                {fmtDateTime(e.ts, site.timezone)} · {ERASE_METHOD[e.method] ?? e.method}
                {e.handled_by && <span className="font-normal text-stone-500"> · {e.handled_by === 'api' ? 'API key' : 'Dashboard'}</span>}
                {e.note && <span className="font-normal text-stone-500"> · {e.note}</span>}
              </span>
              <span className="text-stone-500">
                {ERASE_KINDS.filter(([k]) => e.counts[k])
                  .map(([k, one, many]) => `${e.counts[k]} ${e.counts[k] === 1 ? one : many}`)
                  .join(', ') || 'Nothing matched'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-stone-500">
        The log of every site, deleted ones included:{' '}
        <a className="underline" href="/api/erasures?format=csv" download>
          all sites as CSV
        </a>
        .
      </p>
    </SettingsCard>
  );
}

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  push: boolean;
  widgetPush: boolean;
}

/** Phones signed in through the mobile API. Not tied to this site: every phone sees every site. */
export function DevicesCard() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const setup = useSetup();

  const load = () =>
    api<{ devices: Device[] }>('/api/mobile/devices')
      .then((r) => (setDevices(r.devices), setError('')))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function revoke(d: Device) {
    if (!confirm(`Revoke ${d.name}? It signs out and has to log in again.`)) return;
    setError('');
    try {
      await api(`/api/mobile/devices/${d.id}`, { method: 'DELETE' });
      await load();
      setup?.reload();
      toast(`${d.name} signed out`, 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SettingsCard id="devices" title="Devices" desc="Phones signed in to the iPhone app. They see every site here. Revoking a phone signs it out and stops its notifications.">
      {error && <InlineError message={error} onRetry={load} />}
      {!devices && !error && <SkeletonRows rows={2} />}
      {devices && !devices.length && (
        <EmptyState compact icon={EmptyIcons.plug} title="No phone has signed in yet">
          Scan the code in the iPhone app card above to sign in.
        </EmptyState>
      )}
      <ul className="divide-y divide-stone-200/60">
        {(devices ?? []).map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{d.name}</div>
              <div className="text-xs text-stone-500">
                Last seen {Date.now() - d.lastSeenAt < 60_000 ? 'just now' : `${fmtAgo(Date.now() - d.lastSeenAt)} ago`}
                {' · '}
                {d.push ? 'Notifications on' : 'Notifications off'}
              </div>
            </div>
            <button className="btn text-red-600" onClick={() => revoke(d)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

interface Member {
  id: string;
  name: string;
  email: string | null;
  role: 'viewer' | 'owner';
  status: 'active' | 'invited' | 'expired';
  last_login_at: number | null;
  invite_expires: number | null;
}

/** Teammate logins for the whole deployment (pro/worker/team.ts): invite by link, reset link, revoke. */
export function TeamCard() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'owner'>('viewer');
  const [link, setLink] = useState<{ who: string; url: string; expires: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = useSetup();
  const status = useCardStatus('team', { id: '' } as Site);

  const load = () =>
    api<{ members: Member[] }>('/api/team')
      .then((r) => (setMembers(r.members), setError('')))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function run(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await load();
      setup?.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const show = (who: string, r: { invite_url: string; invite_expires: number }) => setLink({ who, url: r.invite_url, expires: r.invite_expires });

  return (
    <SettingsCard
      id="team"
      title="Team"
      status={status}
      desc="People who sign in with their own password, on every site. A viewer reads. An owner changes everything. Revoking one person signs out only them."
    >
      {error && <InlineError message={error} onRetry={load} />}
      {!members && !error && <SkeletonRows rows={2} />}
      {members && !members.length && <p className="mb-1 text-sm text-stone-500">Nobody yet. You sign in with ADMIN_PASSWORD.</p>}
      <ul className="divide-y divide-stone-200/60">
        {(members ?? []).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-600" aria-hidden="true">
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 truncate font-medium">
                  {m.name} <StatusChip tone={m.role === 'owner' ? 'info' : 'neutral'} dot={false}>{m.role === 'owner' ? 'Owner' : 'Viewer'}</StatusChip>
                </div>
                <div className="text-xs text-stone-500">
                  {m.email ? `${m.email} · ` : ''}
                  {m.status === 'active'
                    ? m.last_login_at
                      ? `Last sign-in ${fmtAgo(Math.max(0, Date.now() - m.last_login_at))} ago`
                      : 'Never signed in'
                    : m.status === 'invited'
                      ? `Invited, link expires ${new Date(m.invite_expires!).toLocaleDateString()}`
                      : 'Invite expired'}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn h-8" disabled={busy} onClick={() => run(async () => show(m.name, await api(`/api/team/${m.id}/reset`, { method: 'POST' })))}>
                {m.status === 'active' ? 'Reset link' : 'New link'}
              </button>
              <button className="btn h-8" disabled={busy} onClick={() => run(() => api(`/api/team/${m.id}`, { method: 'PATCH', json: { role: m.role === 'owner' ? 'viewer' : 'owner' } }))}>
                Make {m.role === 'owner' ? 'viewer' : 'owner'}
              </button>
              <button
                className="btn h-8 text-red-600"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Revoke ${m.name}? Their browser signs out on its next request, and the API keys, read keys and share links they made are deleted. Site write keys, webhook secrets, alert webhooks, phone tokens and anything made by someone else stay valid. Rotate those if ${m.name} saw them.`,
                    )
                  )
                    run(() => api(`/api/team/${m.id}`, { method: 'DELETE' }));
                }}
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>

      {link && (
        <div className="mt-4 rounded-xl bg-emerald-50 p-3.5 text-sm ring-1 ring-inset ring-emerald-200/60">
          <p className="mb-2 text-emerald-900">
            Send this link to {link.who}. It works once and expires {new Date(link.expires).toLocaleDateString()}. It is not shown again.
          </p>
          <CopyField value={link.url} />
        </div>
      )}

      <form
        className="mt-5 grid gap-2 border-t border-stone-200/60 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api<{ name: string; invite_url: string; invite_expires: number }>('/api/team', { method: 'POST', json: { name, email: email || undefined, role } });
            show(r.name, r);
            setName('');
            setEmail('');
          });
        }}
      >
        <div>
          <label className="label" htmlFor="team-name">
            Name
          </label>
          <input id="team-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="team-email">
            Email, optional
          </label>
          <input id="team-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="team-role">
            Role
          </label>
          <select id="team-role" className="input" value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'owner')}>
            <option value="viewer">Viewer</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button className="btn-dark" disabled={!name.trim() || busy}>
          Invite
        </button>
      </form>
    </SettingsCard>
  );
}

/** Delete the site after typing its domain, or the app's name. */
export function DeleteSiteCard({ site }: { site: Site }) {
  const appOnly = isAppOnly(site);
  const word = appOnly ? site.name : site.domain;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section id="delete-site" className="card scroll-mt-24 border-red-200/80 p-5" aria-labelledby="delete-site-title">
      <h3 id="delete-site-title" className="text-title text-ink">
        Delete this {appOnly ? 'app' : 'site'}
      </h3>
      <p className="mt-1 max-w-2xl text-sm text-stone-500">
        Deletes every visit, event, payment and setting of {site.name}. Its erase log stays. There is no undo.
      </p>
      <form
        className="mt-4 flex max-w-lg flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (typed !== word) return;
          setBusy(true);
          setError('');
          try {
            await api(`/api/sites/${site.id}`, { method: 'DELETE' });
            toast(`${site.name} deleted`, 'ok');
            navigate('/');
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="delete-confirm">
            Type <span className="font-mono text-ink">{word}</span> to confirm
          </label>
          <input id="delete-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <button className="btn border-red-300 bg-red-600 text-[#fff] hover:border-red-400 hover:bg-red-700" disabled={typed !== word || busy}>
          {busy ? (
            <>
              <Spinner /> Deleting
            </>
          ) : (
            `Delete ${appOnly ? 'app' : 'site'} and all data`
          )}
        </button>
      </form>
      {error && (
        <div className="mt-2">
          <InlineError message={error} />
        </div>
      )}
    </section>
  );
}
