import { memo, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../App';
import { prefetchProps } from '../../lib/prefetch';
import { fmtAgo, fmtDuration, fmtNumber, fmtPct } from '../../lib/format';
import { CapBadge } from '../CapBadge';
import { SourceIcon } from '../Icons';
import { APP_VISITORS_NOTE } from '../OverviewCard';
import { DOWN_IS_GOOD, METRIC_NOTE, TYPE_LABEL, type MetricKey } from '../ProductType';
import { LiveDot, Segmented } from '../ui';
import { AreaSpark, BarStrip } from './Spark';
import { Change, currenciesOf, money, MRR_NOTE, PAYMENTS_ONLY_NOTE, REVENUE_NOTE, SiteIcon, TrendChip, useEntrance } from './shared';
import type { SiteRow } from './types';

type Sort = 'visitors' | 'revenue' | 'name';

function useSort(): [Sort, (s: Sort) => void] {
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('rt_home_sort') as Sort) || 'visitors');
  return [
    sort,
    (s) => {
      localStorage.setItem('rt_home_sort', s);
      setSort(s);
    },
  ];
}

/** The three numbers on an extension's or a newsletter's card, headline first. */
const CARD_METRICS: Record<'extension' | 'newsletter', MetricKey[]> = {
  extension: ['weekly_active', 'installs', 'uninstalls'],
  newsletter: ['subscribers', 'new_subscribers', 'opens'],
};

/** One number on a card: a label, the value, and what is under it. */
function Metric({ label, dot, value, under, title, muted, zero = false }: { label: ReactNode; dot?: string; value: ReactNode; under: ReactNode; title?: string; muted: boolean; zero?: boolean }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-1.5 truncate text-xs text-stone-500">
        {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />}
        {label}
      </div>
      <div className={`mt-0.5 text-[17px] font-semibold leading-6 tracking-[-0.01em] tabular-nums ${zero ? 'text-stone-400' : muted ? 'text-stone-500' : 'text-ink'}`}>{value}</div>
      <div className="mt-0.5 min-h-[18px]">{under}</div>
    </div>
  );
}

const SiteCard = memo(function SiteCard({ site: s, period, minBase, granularity }: { site: SiteRow; period: string; minBase: number; granularity: string }) {
  const c = s.current;
  const p = s.previous;
  const main = c.revenue[s.currency] ?? 0;
  const appStore = c.appStoreRevenue[s.currency] ?? 0;
  const other = currenciesOf(c.revenue).filter(([cc]) => cc !== s.currency);
  const conv = c.visitors ? c.customers / c.visitors : 0;
  const appShare = c.visitors ? s.appVisitors / c.visitors : 0;
  const visitors = useMemo(() => s.series.map((b) => b.visitors), [s.series]);
  const revenueBars = useMemo(() => s.series.map((b) => b.revenue), [s.series]);
  const peak = Math.max(0, ...visitors);
  const paid = s.payments !== false;
  const hasRevenue = paid && revenueBars.some((v) => v > 0);
  // A quiet site looks quiet: muted charts and numbers, so the live ones stand out.
  const quiet = s.trend.status === 'quiet';
  const tag = (children: ReactNode, title?: string) => (
    <span className="shrink-0 rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-500" title={title}>
      {children}
    </span>
  );
  return (
    <button {...prefetchProps(`/site/${s.id}?period=${period}`)} onClick={() => navigate(`/site/${s.id}?period=${period}`)} className={`card card-hover group flex h-full flex-col p-5 text-left ${quiet ? 'bg-stone-50/60' : ''}`}>
      <div className="flex w-full items-start gap-3">
        <SiteIcon site={s} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className={`truncate text-[15px] font-semibold ${quiet ? 'text-stone-500' : 'text-ink'}`}>{s.name}</div>
            <CapBadge siteId={s.id} />
          </div>
          <div className="truncate text-xs text-stone-500">{s.kind === 'app' ? s.bundleId : s.domain}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <TrendChip status={s.trend.status} />
          {s.online > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] text-stone-500" title="Visitors in the last 5 minutes">
              <LiveDot on size={6} />
              <span className="tabular-nums">{s.online}</span> online
            </span>
          )}
        </div>
      </div>

      {c.visitors > 0 || main > 0 ? (
        <div className="mt-4 w-full" title={`Visitors per ${granularity}, peak ${fmtNumber(peak)}${hasRevenue ? `. Revenue per ${granularity} below.` : ''}`}>
          <div className={quiet ? 'opacity-50' : ''}>
            <AreaSpark values={visitors} height={56} className="text-visitors" />
            {/* The strip keeps its height without revenue, so the numbers under it line up from card to card. */}
            <div className="mt-1.5 h-5 text-revenue">{hasRevenue && <BarStrip values={revenueBars} height={20} />}</div>
          </div>
        </div>
      ) : (
        // One compact line in the chart's height, so the numbers under it line up with the cards beside it.
        <p className="mt-4 flex h-[82px] items-center text-[13px] text-stone-400">
          {s.lastSeen ? (s.kind === 'app' ? 'No app sessions in this period' : 'No visitors in this period') : s.kind === 'app' ? 'Waiting for the first app session' : 'Waiting for the first visit'}
        </p>
      )}

      <div className="mt-4 grid w-full grid-cols-3 gap-3">
        {s.product ? (
          // An extension or a newsletter: its own numbers, headline first; revenue takes the last place when it has payments.
          <>
            {CARD_METRICS[s.product.type].slice(0, paid ? 2 : 3).map((key) => {
              const m = s.product!.metrics.find((x) => x.key === key);
              if (!m) return <div key={key} />;
              const unsub = key === 'new_subscribers' ? s.product!.metrics.find((x) => x.key === 'unsubscribes') : undefined;
              return (
                <Metric
                  key={key}
                  muted={quiet}
                  title={`${METRIC_NOTE[key]}${unsub ? `\n${fmtNumber(unsub.value)} unsubscribes, ${fmtNumber(unsub.previous)} before.` : ''}`}
                  label={m.label}
                  value={fmtNumber(m.value)}
                  under={<Change cur={m.value} prev={m.previous} minBase={minBase} invert={DOWN_IS_GOOD.has(key)} />}
                />
              );
            })}
            {paid && (
              <Metric
                muted={quiet}
                title={REVENUE_NOTE}
                dot="bg-revenue"
                label="Revenue"
                zero={!main}
                value={money(main, s.currency, true)}
                under={<Change cur={main} prev={p.revenue[s.currency] ?? 0} minBase={0} fmt={(n) => money(n, s.currency, true)} />}
              />
            )}
          </>
        ) : (
          <>
            <Metric
              muted={quiet}
              title={s.kind === 'app' ? APP_VISITORS_NOTE : undefined}
              dot="bg-visitors"
              label="Visitors"
              zero={!c.visitors}
              value={fmtNumber(c.visitors)}
              under={<Change cur={c.visitors} prev={p.visitors} minBase={minBase} noData={p.sessions === 0 && !p.visitors} />}
            />
            {!paid ? (
              // No payments connected: how visits went instead of empty money tiles.
              <>
                <Metric
                  muted={quiet}
                  label="Bounce rate"
                  value={c.sessions ? fmtPct(c.bounceRate) : '–'}
                  under={<Change cur={c.bounceRate} prev={p.bounceRate} minBase={0} invert fmt={(n) => `${Math.round(n * 100)} pts`} noData={p.sessions === 0} />}
                />
                {s.goal ? (
                  // The primary goal takes the place of session time (Settings, Primary goal).
                  <Metric
                    muted={quiet}
                    title={`Primary goal: ${s.goal.name}. Visitors who reached it.`}
                    label={s.goal.label}
                    value={fmtNumber(s.goal.count)}
                    under={<Change cur={s.goal.count} prev={s.goal.previous} minBase={minBase} />}
                  />
                ) : (
                  <Metric
                    muted={quiet}
                    label="Session time"
                    value={c.sessions ? fmtDuration(c.avgDuration) : '–'}
                    under={c.sessions && p.sessions ? <span className="text-xs text-stone-400">{fmtDuration(p.avgDuration)} before</span> : null}
                  />
                )}
              </>
            ) : (
              <>
                <Metric
                  muted={quiet}
                  title={`${REVENUE_NOTE}${appStore ? `\nApp Store: ${money(appStore, s.currency)}` : ''}`}
                  dot="bg-revenue"
                  label="Revenue"
                  zero={!main}
                  value={money(main, s.currency, true)}
                  under={
                    other.length > 0 ? (
                      <div className="truncate text-xs text-stone-500" title={other.map(([cc, v]) => money(v, cc)).join(', ')}>
                        + {other.map(([cc, v]) => money(v, cc, true)).join(', ')}
                      </div>
                    ) : (
                      <Change cur={main} prev={p.revenue[s.currency] ?? 0} minBase={0} fmt={(n) => money(n, s.currency, true)} />
                    )
                  }
                />
                {s.appStore ? (
                  <Metric
                    muted={quiet}
                    title={`App Store downloads from Apple's sales report, ${s.appStore.from} to ${s.appStore.to}. First downloads only.`}
                    label="Downloads"
                    zero={!s.appStore.downloads}
                    value={fmtNumber(s.appStore.downloads)}
                    under={<span className="text-xs text-stone-400">App Store</span>}
                  />
                ) : (
                  <Metric
                    muted={quiet}
                    title={`${fmtNumber(c.customers)} new ${c.customers === 1 ? 'customer' : 'customers'}. ${PAYMENTS_ONLY_NOTE}`}
                    label="Conversion"
                    zero={!conv}
                    value={c.visitors ? fmtPct(conv, conv >= 0.1 ? 0 : 1) : '–'}
                    under={
                      c.customers > 0 ? (
                        <span className="block truncate text-xs text-stone-500">
                          {fmtNumber(c.customers)} new {c.customers === 1 ? 'customer' : 'customers'}
                        </span>
                      ) : null
                    }
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {(s.subscriptions || (paid && s.goal)) && (
        <div className="mt-3 w-full space-y-1.5 rounded-xl bg-stone-50 px-3 py-2">
          {s.subscriptions && (
            <div className="flex items-baseline justify-between gap-2 text-xs text-stone-500" title={MRR_NOTE}>
              <span>
                MRR <span className="text-[13px] font-semibold tabular-nums text-ink">{money(s.subscriptions.mrr, s.currency, true)}</span> · {fmtNumber(s.subscriptions.active)} paying
              </span>
              <Change cur={s.subscriptions.mrr} prev={s.subscriptions.mrrStart} minBase={0} fmt={(n) => money(n, s.currency, true)} />
            </div>
          )}
          {paid && s.goal && (
            <div className="flex items-baseline justify-between gap-2 text-xs text-stone-500" title={`Primary goal: ${s.goal.name}. Visitors who reached it.`}>
              <span className="min-w-0 truncate">
                {s.goal.label} <span className="text-[13px] font-semibold tabular-nums text-ink">{fmtNumber(s.goal.count)}</span>
              </span>
              <Change cur={s.goal.count} prev={s.goal.previous} minBase={minBase} />
            </div>
          )}
        </div>
      )}

      <div className="mt-auto w-full pt-4">
        <div className="flex min-h-6 w-full items-center justify-between gap-2 border-t border-stone-200/60 pt-3 text-xs text-stone-500">
          {s.topSource ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <SourceIcon source={s.topSource.label} domain={s.topSource.domain} size={14} />
              <span className="truncate">
                Top source: <span className="text-ink">{s.topSource.label}</span>
              </span>
            </span>
          ) : (
            <span>{s.lastSeen ? `Last ${s.kind === 'app' ? 'session' : 'visit'} ${fmtAgo(Date.now() - s.lastSeen)} ago` : ''}</span>
          )}
          {quiet && s.lastSeen && s.topSource && (
            <span className="shrink-0 text-stone-500">
              Last {s.kind === 'app' ? 'session' : 'visit'} {fmtAgo(Date.now() - s.lastSeen)} ago
            </span>
          )}
          {!quiet && (s.type === 'extension' || s.type === 'newsletter') && tag(TYPE_LABEL[s.type])}
          {!quiet && s.kind === 'app' && tag('iOS app')}
          {!quiet && s.kind === 'both' && Math.round(appShare * 100) > 0 && tag(`${fmtPct(appShare)} from the app`, `${fmtPct(appShare)} of this period's visitors came through the iOS app. The rest came through the website.`)}
        </div>
      </div>
    </button>
  );
});

/** Every site as a card, sorted by visitors, revenue or name (kept in localStorage). */
export function SiteCards({ sites, period, minBase, granularity }: { sites: SiteRow[]; period: string; minBase: number; granularity: string }) {
  const [sort, setSort] = useSort();
  const entrance = useEntrance();
  const sorted = useMemo(() => {
    const rev = (s: SiteRow) => s.current.revenue[s.currency] ?? 0;
    return [...sites].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'revenue' ? rev(b) - rev(a) || b.current.visitors - a.current.visitors : b.current.visitors - a.current.visitors,
    );
  }, [sites, sort]);
  return (
    <section aria-labelledby="sites-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sites-title" className="text-title">
          Sites and apps <span className="ml-1 text-[13px] font-medium tabular-nums text-stone-400">{sites.length}</span>
        </h2>
        <Segmented
          size="sm"
          label="Sort sites"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'visitors', label: 'Most visitors' },
            { value: 'revenue', label: 'Most revenue' },
            { value: 'name', label: 'A to Z' },
          ]}
        />
      </div>
      <div className={`${entrance} mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3`}>
        {sorted.map((s) => (
          <SiteCard key={s.id} site={s} period={period} minBase={minBase} granularity={granularity} />
        ))}
      </div>
    </section>
  );
}
