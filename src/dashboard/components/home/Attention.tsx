import { memo, useMemo, type ReactNode } from 'react';
import { navigate } from '../../App';
import { currencyDecimals, fmtMoney, fmtNumber } from '../../lib/format';
import { Favicon } from '../Icons';
import { PhoneGlyph, useEntrance } from './shared';
import type { ChangesSummary, HomeData, NextAction, SiteRow } from './types';

const CHANGES_NOTE =
  'Changes are the notes you and your agents logged. A verdict comes 7 days after a change, when its window closes, so the verdicts here are for changes made 7 to 14 days ago. Due for review: changes from the last 90 days with a verdict window that closed and no review yet.';

/** Open a site's Overview at its changes list (ChartNotes.tsx, id "changes"), once the list has rendered. */
function openChanges(siteId: string) {
  navigate(`/site/${siteId}?period=30d#changes`);
  const start = Date.now();
  const tick = () => {
    const el = document.getElementById('changes');
    if (el) el.scrollIntoView({ block: 'start' });
    else if (Date.now() - start < 15_000) setTimeout(tick, 200);
  };
  setTimeout(tick, 150);
}

type Kind = HomeData['attention'][0]['kind'];
const TONE: Record<Kind, { ring: string; glyph: ReactNode }> = {
  no_data: { ring: 'bg-stone-100 text-stone-500', glyph: <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /> },
  apps_no_data: { ring: 'bg-stone-100 text-stone-500', glyph: <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /> },
  quiet: { ring: 'bg-amber-50 text-amber-700', glyph: <path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> },
  traffic_down: { ring: 'bg-red-50 text-red-600', glyph: <path d="M8 4v8M4.8 8.8 8 12l3.2-3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> },
  traffic_up: { ring: 'bg-emerald-50 text-emerald-700', glyph: <path d="M8 12V4M4.8 7.2 8 4l3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> },
  falling: { ring: 'bg-red-50 text-red-600', glyph: <path d="M4 5l4 4 1.6-1.6L12 10M12 6.8V10H8.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> },
  first_sale: { ring: 'bg-revenueSoft text-revenue', glyph: <path d="m8 3.8 1.3 2.7 3 .4-2.2 2 .6 2.9L8 10.4l-2.7 1.4.6-2.9-2.2-2 3-.4z" fill="currentColor" /> },
  payments_stopped: { ring: 'bg-red-50 text-red-600', glyph: <path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> },
  webhook_refused: { ring: 'bg-red-50 text-red-600', glyph: <path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> },
  search_drop: { ring: 'bg-red-50 text-red-600', glyph: <path d="M3.5 5.5 7 9l2-2 3.5 3.5M12.5 7.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> },
};

/** The tab each kind of next action opens, as the arrow's label. */
const ACTION_TAB: Record<NextAction['kind'], string> = {
  integration_failing: 'Settings',
  seo_decay: 'SEO',
  seo_striking: 'SEO',
  ad_fatigue: 'Ads',
  asa_low_roas: 'Ads',
  failed_renewals: 'Subscriptions',
  ai_lost_mentions: 'AI',
};

/** "$1,240 a month" or "140 clicks": what an action is worth, as the list's right column. */
function actionWorth(a: NextAction): string | null {
  if (a.value !== null && a.value > 0 && a.currency) return `${fmtMoney(a.value, a.currency, currencyDecimals(a.currency), true)} a month`;
  if (a.clicks) return `${fmtNumber(a.clicks)} clicks`;
  return null;
}

const ACTION_GLYPH = <path d="M5 8h6M8.5 5.5 11 8l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />;

function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="transition-transform duration-fast group-hover:translate-x-0.5">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/**
 * The agent line: changes logged in the last 7 days, the verdicts that came in, the ones due for review, and the worst
 * change as a link to its site's changes list (pro/worker/changes-summary.ts).
 */
function ChangesRow({ changes: c, domain }: { changes: ChangesSummary; domain: Map<string, string> }) {
  const verdicts = c.better + c.worse + c.inconclusive;
  const split = [
    { n: c.better, text: 'better', cls: 'text-emerald-700' },
    { n: c.worse, text: 'worse', cls: 'text-red-600' },
    { n: c.inconclusive, text: 'inconclusive', cls: 'text-stone-500' },
  ].filter((x) => x.n > 0);
  return (
    <div className="flex flex-col gap-2 px-5 py-3 text-[13px] lg:flex-row lg:items-center lg:justify-between" aria-label="Changes in the last 7 days" role="group">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1" title={CHANGES_NOTE}>
        <span className="font-medium text-ink">{c.count === 1 ? '1 change' : `${fmtNumber(c.count)} changes`} in 7 days</span>
        {verdicts > 0 && (
          <>
            <span className="hidden text-stone-300 sm:inline" aria-hidden="true">
              ·
            </span>
            <span className="text-stone-500">
              Verdicts in:{' '}
              {split.map((x, i) => (
                <span key={x.text}>
                  {i > 0 && ', '}
                  <span className={`font-medium ${x.cls}`}>
                    {x.n} {x.text}
                  </span>
                </span>
              ))}
            </span>
          </>
        )}
        {c.due > 0 && (
          <>
            <span className="hidden text-stone-300 sm:inline" aria-hidden="true">
              ·
            </span>
            <span className="text-stone-500">{fmtNumber(c.due)} due for review</span>
          </>
        )}
      </p>
      {c.worst && (
        <button className="group flex min-w-0 items-center gap-2 rounded-lg text-left text-stone-500 transition-colors duration-fast hover:text-ink lg:max-w-[55%]" onClick={() => openChanges(c.worst!.site_id)} title={c.worst.reason}>
          <Favicon domain={domain.get(c.worst.site_id)} size={14} />
          <span className="min-w-0 truncate">
            <span className="font-medium text-red-600">Worse:</span> {c.worst.text}
            {c.worst.actor ? ` (${c.worst.actor})` : ''}, {c.worst.site_name}
          </span>
          {c.worst.change_pct !== null && (
            <span className="shrink-0 font-medium tabular-nums text-red-600">
              {c.worst.change_pct < 0 ? '−' : '+'}
              {Math.abs(c.worst.change_pct)}%
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1 text-xs text-stone-400">
            Changes <Arrow />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * What changed and needs a look, in one card: the attention items, the next actions computed once a day (the most money
 * or clicks at stake first), then the changes line under a hairline.
 */
export const WorthALook = memo(function WorthALook({ items, actions = [], changes, sites }: { items: HomeData['attention']; actions?: NextAction[]; changes: ChangesSummary | null | undefined; sites: SiteRow[] }) {
  const domain = useMemo(() => new Map(sites.map((s) => [s.id, s.domain])), [sites]);
  const entrance = useEntrance();
  const showChanges = !!changes && (changes.count > 0 || changes.better + changes.worse + changes.inconclusive > 0 || changes.due > 0);
  if (!items.length && !actions.length && !showChanges) return null;
  return (
    <section className="card overflow-hidden" aria-labelledby="worth-title">
      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h2 id="worth-title" className="text-title">
              Worth a look
            </h2>
            <span className="text-xs tabular-nums text-stone-400">{items.length}</span>
          </div>
          <ul className={`${entrance} px-2 pb-2`}>
            {items.map((a, i) => {
              const t = TONE[a.kind];
              return (
                <li key={`${a.siteId}-${a.kind}-${i}`}>
                  <button
                    className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-fast hover:bg-stone-50"
                    onClick={() => navigate(a.link === 'apps' ? '/apps' : a.link === 'settings' ? `/site/${a.siteId}/settings` : a.link === 'seo' ? `/site/${a.siteId}/seo` : `/site/${a.siteId}`)}
                  >
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${t.ring}`} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16">
                        {t.glyph}
                      </svg>
                    </span>
                    {a.kind === 'apps_no_data' ? <PhoneGlyph size={16} /> : <Favicon domain={domain.get(a.siteId)} size={16} />}
                    <span className="min-w-0 flex-1 text-ink">{a.text}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-stone-400 transition-colors duration-fast group-hover:text-ink">
                      <span className="hidden sm:inline">{a.link === 'apps' ? 'All apps' : a.link === 'settings' ? 'Settings' : a.link === 'seo' ? 'SEO' : 'Open'}</span> <Arrow />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {actions.length > 0 && (
        <div className={items.length ? 'border-t border-stone-200/60' : ''}>
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h3 id={items.length ? undefined : 'worth-title'} className="text-title" title="Computed once a day from Search Console, ads, subscriptions, AI answers and integration health. Each amount is an estimate for about a month.">
              Next actions
            </h3>
            <span className="text-xs tabular-nums text-stone-400">{actions.length}</span>
          </div>
          <ul className={`${entrance} px-2 pb-2`}>
            {actions.map((a, i) => {
              const worth = actionWorth(a);
              return (
                <li key={`${a.site_id}-${a.kind}-${i}`}>
                  <button
                    className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-fast hover:bg-stone-50"
                    onClick={() => navigate(a.link)}
                    title={a.value_basis ?? undefined}
                  >
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${a.kind === 'integration_failing' ? 'bg-red-50 text-red-600' : 'bg-stone-100 text-stone-600'}`} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16">
                        {a.kind === 'integration_failing' ? TONE.webhook_refused.glyph : ACTION_GLYPH}
                      </svg>
                    </span>
                    <Favicon domain={domain.get(a.site_id)} size={16} />
                    <span className="min-w-0 flex-1 text-ink">{a.title}</span>
                    {worth && <span className="hidden shrink-0 text-xs font-medium tabular-nums text-stone-500 sm:inline">{worth}</span>}
                    <span className="flex shrink-0 items-center gap-1 text-xs text-stone-400 transition-colors duration-fast group-hover:text-ink">
                      <span className="hidden sm:inline">{ACTION_TAB[a.kind]}</span> <Arrow />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {showChanges && (
        <div className={items.length || actions.length ? 'border-t border-stone-200/60' : ''}>
          {!items.length && !actions.length && <h2 id="worth-title" className="sr-only">Changes</h2>}
          <ChangesRow changes={changes!} domain={domain} />
        </div>
      )}
    </section>
  );
});
