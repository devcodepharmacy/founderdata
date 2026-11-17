import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../App';
import { currencyDecimals, fmtMoney, fmtNumber } from '../../lib/format';
import { Favicon } from '../Icons';
import { InfoTip } from '../InfoTip';
import { CardHeader } from '../ui';
import { PhoneGlyph, useEntrance } from './shared';
import type { ChangesSummary, HomeData, NextAction, SiteRow } from './types';

const CHANGES_NOTE =
  'Changes are the notes you and your agents logged. A verdict comes 7 days after a change, when its window closes, so the verdicts here are for changes made 7 to 14 days ago. Due for review: changes from the last 90 days with a verdict window that closed and no review yet.';
const ACTIONS_NOTE = 'Computed once a day from Search Console, ads, subscriptions, AI answers and integration health. Each amount is an estimate for about a month.';

/** Rows a list shows before "Show all". */
const SHOWN = 4;

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

/** What a group of actions is worth together: the sum when every one has the same kind of figure, else nothing. */
function groupWorth(items: NextAction[]): string | null {
  if (items.length === 1) return actionWorth(items[0]);
  const money = items.every((a) => a.value !== null && a.value > 0 && a.currency && a.currency === items[0].currency);
  if (money) return `${fmtMoney(items.reduce((t, a) => t + a.value!, 0), items[0].currency!, currencyDecimals(items[0].currency!), true)} a month`;
  if (items.every((a) => a.clicks)) return `${fmtNumber(items.reduce((t, a) => t + a.clicks!, 0))} clicks`;
  return null;
}

/**
 * The server writes one to three sentences per item. The first is the headline (one line, no final period); the rest is
 * the detail, a muted second line that opens on a click. Dates such as 2026-09-29 stay exactly as the server sent them.
 */
export function splitText(text: string): { headline: string; rest: string } {
  const m = /^(.*?[.!?])(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return { headline: text.trim(), rest: '' };
  return { headline: m[1].replace(/[.!?]+$/, ''), rest: (m[2] ?? '').trim() };
}

function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="transition-transform duration-fast group-hover:translate-x-0.5">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function Glyph({ ring, children }: { ring: string; children: ReactNode }) {
  return (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ring}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16">
        {children}
      </svg>
    </span>
  );
}

type Place = { id: string; name: string; domain: string | undefined; app?: boolean; href: string };

/**
 * One row of either list: the severity glyph, the site's favicon (several side by side for a group), the headline on one
 * line and the detail under it. The headline button stretches over the whole row, so a click anywhere opens `href`; the
 * detail and the group count sit above it as their own buttons. `places` with more than one entry opens a list of links.
 */
function AttentionRow({
  glyph,
  places,
  headline,
  rest,
  full,
  href,
  linkLabel,
  worth,
  title,
}: {
  glyph: ReactNode;
  places: Place[];
  headline: string;
  rest: string;
  full: string;
  href: string;
  linkLabel: string;
  worth?: string | null;
  title?: string;
}) {
  const [more, setMore] = useState(false);
  const [sites, setSites] = useState(false);
  const list = useId();
  const group = places.length > 1;
  return (
    <li className="group relative rounded-xl transition-colors duration-fast hover:bg-stone-50">
      <div className="flex min-h-10 items-start gap-3 px-3 py-2">
        <span className="mt-px">{glyph}</span>
        <span className="mt-1 shrink-0">{places[0].app ? <PhoneGlyph size={16} /> : <Favicon domain={places[0].domain} size={16} />}</span>
        <div className="min-w-0 flex-1">
          <button type="button" className="block w-full text-left text-[13px] leading-6 text-ink after:absolute after:inset-0 after:rounded-xl max-sm:line-clamp-2 sm:truncate" onClick={() => navigate(href)} title={title ?? full}>
            {headline}
          </button>
          {rest && (
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore((o) => !o)}
              className={`relative z-10 -mt-0.5 block w-full rounded text-left text-xs leading-5 text-stone-400 transition-colors duration-fast hover:text-stone-500 ${more ? '' : 'truncate'}`}
              title={more ? undefined : full}
            >
              {rest}
            </button>
          )}
        </div>
        {group && (
          <span className="mt-1 hidden shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
            {places.slice(0, 4).map((p) => (
              <span key={p.id}>{p.app ? <PhoneGlyph size={16} /> : <Favicon domain={p.domain} size={16} />}</span>
            ))}
          </span>
        )}
        {group && (
          <button
            type="button"
            aria-expanded={sites}
            aria-controls={list}
            onClick={() => setSites((o) => !o)}
            className="relative z-10 mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-stone-100 px-1.5 text-[11px] font-medium tabular-nums text-stone-500 transition-colors duration-fast hover:text-ink"
            title={places.map((p) => p.name).join(', ')}
          >
            {places.length} sites
          </button>
        )}
        {worth && <span className="mt-1 hidden shrink-0 text-xs font-medium tabular-nums text-stone-500 sm:inline">{worth}</span>}
        <span className="mt-1 flex shrink-0 items-center gap-1 text-xs text-stone-400 transition-colors duration-fast group-hover:text-ink">
          <span className="hidden sm:inline">{linkLabel}</span> <Arrow />
        </span>
      </div>
      {group && sites && (
        <ul id={list} className="relative z-10 mb-1 ml-[3.75rem] mr-3 animate-fade border-t border-stone-200/60 pb-1 pt-1 text-[13px]">
          {places.map((p) => (
            <li key={p.id}>
              <a
                href={p.href}
                className="flex h-8 items-center gap-2 rounded-lg px-2 text-stone-600 transition-colors duration-fast hover:bg-stone-100 hover:text-ink"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(p.href);
                }}
              >
                {p.app ? <PhoneGlyph size={16} /> : <Favicon domain={p.domain} size={16} />}
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-stone-400">{linkLabel}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** At most `SHOWN` rows, then a quiet toggle for the rest. */
function ShownList({ rows, label }: { rows: ReactNode[]; label: string }) {
  const [all, setAll] = useState(false);
  const entrance = useEntrance();
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <>
      <ul className={`${entrance} px-2`} aria-label={label}>
        {shown}
      </ul>
      {rows.length > SHOWN && (
        <div className="px-5 pb-2 pt-1">
          <button type="button" className="rounded text-xs font-medium text-stone-500 transition-colors duration-fast hover:text-ink" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        </div>
      )}
      {rows.length <= SHOWN && <div className="pb-2" />}
    </>
  );
}

/** Heading of one list: the card header with the count on its right. */
function ListHeader({ id, title, count, info }: { id?: string; title: string; count: number; info?: ReactNode }) {
  return (
    <CardHeader
      className="!pb-1"
      title={
        <h2 id={id} className="truncate text-[13px] font-semibold leading-6 text-ink">
          {title}
        </h2>
      }
      info={info}
      infoLabel={`About ${title.toLowerCase()}`}
      right={<span className="text-xs tabular-nums text-stone-400">{count}</span>}
    />
  );
}

/**
 * The agent line: changes logged in the last 7 days, the verdicts that came in, the ones due for review, and the worst
 * change as a link to its site's changes list (pro/worker/changes-summary.ts). One quiet line in the card's footer.
 */
function ChangesRow({ changes: c, domain }: { changes: ChangesSummary; domain: Map<string, string> }) {
  const verdicts = c.better + c.worse + c.inconclusive;
  const split = [
    { n: c.better, text: 'better', cls: 'text-emerald-700' },
    { n: c.worse, text: 'worse', cls: 'text-red-600' },
    { n: c.inconclusive, text: 'inconclusive', cls: 'text-stone-500' },
  ].filter((x) => x.n > 0);
  const dot = (
    <span className="hidden text-stone-300 sm:inline" aria-hidden="true">
      ·
    </span>
  );
  return (
    <div className="flex flex-col gap-1.5 px-5 py-3 text-[13px] text-stone-500 lg:flex-row lg:items-center lg:justify-between" aria-label="Changes in the last 7 days" role="group">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-ink">{c.count === 1 ? '1 change' : `${fmtNumber(c.count)} changes`} in 7 days</span>
        {verdicts > 0 && (
          <>
            {dot}
            <span>
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
            {dot}
            <span>{fmtNumber(c.due)} due for review</span>
          </>
        )}
        <InfoTip label="How changes and verdicts are counted">{CHANGES_NOTE}</InfoTip>
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

/** Consecutive actions with the same words for different sites become one: "Check AI engines" on three sites. */
function groupActions(actions: NextAction[]): NextAction[][] {
  const out: NextAction[][] = [];
  for (const a of actions) {
    const last = out[out.length - 1];
    if (last && last[0].title === a.title && last[0].kind === a.kind && !last.some((x) => x.site_id === a.site_id)) last.push(a);
    else out.push([a]);
  }
  return out;
}

/**
 * What changed and needs a look, in one card: the attention items, the next actions computed once a day (the most money
 * or clicks at stake first), then the changes line under a hairline. Each row is a headline and a muted detail line,
 * four rows to a list.
 */
export const WorthALook = memo(function WorthALook({ items, actions = [], changes, sites }: { items: HomeData['attention']; actions?: NextAction[]; changes: ChangesSummary | null | undefined; sites: SiteRow[] }) {
  const byId = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const domain = useMemo(() => new Map(sites.map((s) => [s.id, s.domain])), [sites]);
  const grouped = useMemo(() => groupActions(actions), [actions]);
  const showChanges = !!changes && (changes.count > 0 || changes.better + changes.worse + changes.inconclusive > 0 || changes.due > 0);
  if (!items.length && !actions.length && !showChanges) return null;

  const attention = items.map((a, i) => {
    const t = TONE[a.kind];
    const site = byId.get(a.siteId);
    const href = a.link === 'apps' ? '/apps' : a.link === 'settings' ? `/site/${a.siteId}/settings` : a.link === 'seo' ? `/site/${a.siteId}/seo` : `/site/${a.siteId}`;
    const { headline, rest } = splitText(a.text);
    return (
      <AttentionRow
        key={`${a.siteId}-${a.kind}-${i}`}
        glyph={<Glyph ring={t.ring}>{t.glyph}</Glyph>}
        places={[{ id: a.siteId, name: site?.name ?? a.siteId, domain: site?.domain, app: a.kind === 'apps_no_data', href }]}
        headline={headline}
        rest={rest}
        full={a.text}
        href={href}
        linkLabel={a.link === 'apps' ? 'All apps' : a.link === 'settings' ? 'Settings' : a.link === 'seo' ? 'SEO' : 'Open'}
      />
    );
  });

  const next = grouped.map((g, i) => {
    const a = g[0];
    const { headline, rest } = splitText(a.title);
    const failing = a.kind === 'integration_failing';
    return (
      <AttentionRow
        key={`${a.site_id}-${a.kind}-${i}`}
        glyph={<Glyph ring={failing ? 'bg-red-50 text-red-600' : 'bg-stone-100 text-stone-600'}>{failing ? TONE.webhook_refused.glyph : <path d="M5 8h6M8.5 5.5 11 8l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}</Glyph>}
        places={g.map((x) => {
          const s = byId.get(x.site_id);
          return { id: x.site_id, name: s?.name ?? x.site_id, domain: s?.domain, href: x.link };
        })}
        headline={headline}
        rest={rest}
        full={a.title}
        href={a.link}
        linkLabel={ACTION_TAB[a.kind]}
        worth={groupWorth(g)}
        title={a.value_basis ? `${a.title}\n${a.value_basis}` : a.title}
      />
    );
  });

  return (
    <section className="card overflow-hidden" aria-labelledby="worth-title">
      {items.length > 0 && (
        <>
          <ListHeader id="worth-title" title="Worth a look" count={items.length} />
          <ShownList rows={attention} label="Worth a look" />
        </>
      )}
      {actions.length > 0 && (
        <div className={items.length ? 'border-t border-stone-200/60' : ''}>
          <ListHeader id={items.length ? undefined : 'worth-title'} title="Next actions" count={actions.length} info={ACTIONS_NOTE} />
          <ShownList rows={next} label="Next actions" />
        </div>
      )}
      {showChanges && (
        <div className={items.length || actions.length ? 'border-t border-stone-200/60' : ''}>
          {!items.length && !actions.length && (
            <h2 id="worth-title" className="sr-only">
              Changes
            </h2>
          )}
          <ChangesRow changes={changes!} domain={domain} />
        </div>
      )}
    </section>
  );
});
