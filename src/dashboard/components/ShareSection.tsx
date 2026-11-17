import { useEffect, useState } from 'react';
import { api, type Site } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { isAppOnly } from '../lib/siteKind';
import { CopyField, InlineError, SettingsCard } from './setup/kit';
import { useCardStatus, useSetup } from './setup/status';
import { EmptyState, EmptyIcons, SkeletonRows, Spinner, StatusChip, toast } from './ui';

/** A share link, a read API key, or a read key for all sites (src/worker/share.ts, docs/API.md). */
interface ShareToken {
  token: string;
  kind: 'link' | 'api' | 'all';
  label: string | null;
  show_revenue: boolean;
  created_at: number;
  expires_at: number | null;
}

const EXPIRY = [
  { days: 0, label: 'Never expires' },
  { days: 7, label: 'Expires in 7 days' },
  { days: 30, label: 'Expires in 30 days' },
  { days: 90, label: 'Expires in 90 days' },
];

function CreateForm({ kind, onCreate }: { kind: 'link' | 'api'; onCreate: (body: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<'api' | 'all'>('api');
  const [revenue, setRevenue] = useState(true);
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-stone-200/60 pt-4"
      aria-label={kind === 'link' ? 'New share link' : 'New read key'}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onCreate({ kind: kind === 'api' ? scope : kind, label, show_revenue: revenue, expires_days: days || null });
        setBusy(false);
        setLabel('');
      }}
    >
      <input
        className="input w-auto min-w-[180px] flex-1 py-1.5"
        placeholder={kind === 'link' ? 'Label, such as Investor update' : 'Label, such as Grafana'}
        aria-label="Label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={80}
      />
      {kind === 'link' && (
        <select className="input w-auto py-1.5" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expiry">
          {EXPIRY.map((x) => (
            <option key={x.days} value={x.days}>
              {x.label}
            </option>
          ))}
        </select>
      )}
      {kind === 'api' && (
        <select className="input w-auto py-1.5" value={scope} onChange={(e) => setScope(e.target.value as 'api' | 'all')} aria-label="Sites the key reads">
          <option value="api">This site only</option>
          <option value="all">All sites</option>
        </select>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={revenue} onChange={(e) => setRevenue(e.target.checked)} /> Show revenue
      </label>
      <button className="btn-dark" disabled={busy}>
        {busy ? (
          <>
            <Spinner /> Creating
          </>
        ) : kind === 'link' ? (
          'Create share link'
        ) : (
          'Create read key'
        )}
      </button>
    </form>
  );
}

/**
 * Share links for one site: a read-only dashboard at /share/<token>, plus a badge. Self-contained:
 * it loads and changes its own data. Mount it in the site's settings as <ShareSection site={site} />.
 */
export function ShareSection({ site }: { site: Site }) {
  const [tokens, setTokens] = useState<ShareToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const origin = window.location.origin;
  const setup = useSetup();
  const status = useCardStatus('share', site);
  const what = isAppOnly(site) ? site.name : site.domain;

  useEffect(() => {
    // The site's links and keys, then the keys for all sites (POST /api/read-keys), listed with them.
    Promise.all([api<ShareToken[]>(`/api/sites/${site.id}/share`), api<ShareToken[]>('/api/read-keys').catch(() => [])]).then(
      ([own, all]) => (setTokens([...own, ...all]), setError(null)),
      (e) => setError(e.message),
    );
  }, [site.id, n]);

  /** Where a token is managed: the site's routes, or /api/read-keys for an all-sites key. */
  const base = (kind: ShareToken['kind']) => (kind === 'all' ? '/api/read-keys' : `/api/sites/${site.id}/share`);

  const create = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const t = await api<ShareToken>(base(body.kind as ShareToken['kind']), { method: 'POST', json: body });
      setTokens((x) => [...(x ?? []), t]);
      setup?.reload();
      toast('Share link created', 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const update = async (t: ShareToken, patch: Partial<ShareToken>) => {
    try {
      const next = await api<ShareToken>(`${base(t.kind)}/${t.token}`, { method: 'PATCH', json: patch });
      setTokens((x) => (x ?? []).map((y) => (y.token === t.token ? next : y)));
      toast(next.show_revenue ? 'Revenue shows on this link' : 'Revenue hidden on this link', 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revoke = async (t: ShareToken) => {
    const kindName = t.kind === 'link' ? 'share link' : t.kind === 'all' ? 'read key for all sites' : 'read key';
    if (!confirm(`Revoke this ${kindName}${t.label ? ` (${t.label})` : ''}? It stops working within a minute.`)) return;
    try {
      await api(`${base(t.kind)}/${t.token}`, { method: 'DELETE' });
      setTokens((x) => (x ?? []).filter((y) => y.token !== t.token));
      setup?.reload();
      toast('Share link revoked', 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Read keys (rtr_) are listed under Agents (ApiKeys.tsx), with the scoped keys that replace them.
  const links = (tokens ?? []).filter((t) => t.kind === 'link');

  return (
    <SettingsCard
      id="share"
      title="Share links"
      status={status}
      desc={`A read-only dashboard of ${what} for anyone with the link: visitors, sources, pages, countries and devices, plus revenue if you allow it. It never shows visitor profiles, journeys, names, emails or settings.`}
    >
      <div className="space-y-3">
        {!tokens && !error && <SkeletonRows rows={2} />}
        {error && <InlineError message={error} onRetry={() => setN((x) => x + 1)} />}
        {tokens && !links.length && (
          <EmptyState compact icon={EmptyIcons.chart} title="No share links yet">
            Make one for an investor update, a launch post or a public stats page. Revoke it when you're done.
          </EmptyState>
        )}
        {links.map((t) => {
          const expired = !!t.expires_at && t.expires_at < Date.now();
          const badge = `/api/share/${t.token}/badge.svg${t.show_revenue ? '?metric=revenue' : ''}`;
          return (
            <div key={t.token} className="space-y-3 rounded-xl border border-stone-200/80 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="font-medium text-ink">{t.label || 'Share link'}</span>
                {expired ? <StatusChip tone="error">Expired</StatusChip> : <StatusChip tone="ok">Open</StatusChip>}
                <span className="text-xs text-stone-500">
                  Created {fmtDateTime(t.created_at, site.timezone)}
                  {t.expires_at && !expired ? ` · expires ${fmtDateTime(t.expires_at, site.timezone)}` : ''}
                </span>
                <span className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[13px] text-stone-600">
                    <input type="checkbox" checked={t.show_revenue} onChange={(e) => update(t, { show_revenue: e.target.checked })} /> Show revenue
                  </label>
                  <a className="btn h-8" href={`/share/${t.token}`} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <button className="btn h-8 text-red-600" onClick={() => revoke(t)}>
                    Revoke
                  </button>
                </span>
              </div>
              <CopyField value={`${origin}/share/${t.token}`} />
              <details className="text-sm">
                <summary className="cursor-pointer text-[13px] font-medium text-stone-500 hover:text-ink">Badge for a README or website</summary>
                <div className="mt-2 space-y-2">
                  <img src={badge} alt="" height={20} />
                  <CopyField value={`<a href="${origin}/share/${t.token}"><img src="${origin}${badge}" alt="${what} stats"></a>`} />
                  <p className="text-xs text-stone-500">
                    Add <code>?metric=revenue</code> or <code>?metric=visitors</code>, and <code>&amp;period=</code> 7d, 30d, 90d, 12m or all. The badge updates every 5
                    minutes.
                  </p>
                </div>
              </details>
            </div>
          );
        })}
        <CreateForm kind="link" onCreate={create} />
      </div>
    </SettingsCard>
  );
}
