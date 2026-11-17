import { memo, useMemo, type ReactNode } from 'react';
import { navigate } from '../../App';
import { TREND_RULES } from '../../../shared/trend-rules';
import { fmtNumber } from '../../lib/format';
import { prefetchProps } from '../../lib/prefetch';
import { headlineOf, METRIC_NOTE, type ProductNumbers } from '../ProductType';
import { CardHeader } from '../ui';
import { WeekSpark } from './Spark';
import {
  Change,
  InfoIcon,
  money,
  MRR_NOTE,
  MrrChange,
  noRevenue,
  PERIOD_PHRASE,
  PREVIOUS,
  RevenueChange,
  shortDate,
  signedPct,
  SiteIcon,
  STATUS_NOTE,
  STATUS_ORDER,
  statusLabel,
  TrendChip,
  useEntrance,
} from './shared';
import type { SiteGoal, SiteRow } from './types';

type Drop = { site: SiteRow; what: ReactNode };

/**
 * The site that lost the most over the panel's window, the same numbers as its row. Revenue first, in the site's
 * currency. When no site lost revenue, the biggest visitor drop on a base of TREND_RULES.visitorBase. A quiet site is
 * listed under Quiet with its last visit, not here as a made-up -100%.
 */
function biggestDrop(rows: SiteRow[]): Drop | null {
  const last = rows[rows.length - 1];
  if (last && last.trend.revenueChange < 0) return { site: last, what: <RevenueChange site={last} /> };
  let best: { site: SiteRow; share: number } | null = null;
  for (const r of rows) {
    const cur = r.current.visitors;
    const prev = r.previous.visitors;
    if (prev < TREND_RULES.visitorBase || cur >= prev) continue;
    const share = (cur - prev) / prev;
    if (!best || share < best.share) best = { site: r, share };
  }
  if (!best) return null;
  return { site: best.site, what: <span className="whitespace-nowrap text-xs font-medium tabular-nums text-red-600">visitors {signedPct(best.share)}</span> };
}

const COLS = 'sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_76px_minmax(0,1fr)]';

/** One fact of the highlight group: a muted label over one line of text, a name and its change on a shared baseline. */
function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={title}>
      <dt className="text-micro uppercase text-stone-400">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-baseline gap-2 text-[13px] font-medium text-ink">{children}</dd>
    </div>
  );
}

/**
 * Every site and app in one list, biggest revenue gain first and biggest loss last, with a status chip each
 * (siteTrend in src/worker/home.ts). Changes are in each site's own currency.
 */
export const Ranking = memo(function Ranking({ sites, period, minBase, tz }: { sites: SiteRow[]; period: string; minBase: number; tz: string }) {
  const rows = useMemo(
    () =>
      [...sites].sort(
        (a, b) =>
          b.trend.revenueChange - a.trend.revenueChange ||
          STATUS_ORDER[a.trend.status] - STATUS_ORDER[b.trend.status] ||
          b.current.visitors - b.previous.visitors - (a.current.visitors - a.previous.visitors),
      ),
    [sites],
  );
  const earning = useMemo(() => rows.filter((r) => !noRevenue(r)), [rows]);
  const idle = useMemo(() => rows.filter(noRevenue), [rows]);
  const gain = rows[0] && rows[0].trend.revenueChange > 0 ? rows[0] : null;
  const drop = useMemo(() => biggestDrop(rows), [rows]);
  const quiet = rows.filter((r) => r.trend.status === 'quiet');
  const entrance = useEntrance();
  const showQuiet = quiet.slice(0, 2);
  const quietTitle = quiet.map((r) => `${r.name}${r.lastSeen !== null ? `, last ${r.kind === 'app' ? 'session' : 'visit'} ${shortDate(r.lastSeen)}` : ''}`).join('\n');
  return (
    <section className="card overflow-hidden" aria-labelledby="ranking-title">
      <CardHeader
        title={
          <h2 id="ranking-title" className="truncate text-[13px] font-semibold leading-6 text-ink">
            Ranked by revenue change
          </h2>
        }
        sub={
          <>
            {PERIOD_PHRASE[period]} against {PREVIOUS[period]}
          </>
        }
        info={`Each site's revenue change in its own currency. ${STATUS_NOTE}`}
        infoLabel="How the ranking works"
      />
      <dl className={`card-inset mx-5 mb-4 grid divide-y divide-stone-200/60 sm:divide-x sm:divide-y-0 ${quiet.length ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <Fact label="Biggest gain">
          {gain ? (
            <>
              <span className="min-w-0 truncate">{gain.name}</span>
              <RevenueChange site={gain} />
            </>
          ) : (
            <span className="font-normal text-stone-400">No gains</span>
          )}
        </Fact>
        <Fact label="Biggest drop">
          {drop ? (
            <>
              <span className="min-w-0 truncate">{drop.site.name}</span>
              {drop.what}
            </>
          ) : (
            <span className="font-normal text-stone-400">No drops</span>
          )}
        </Fact>
        {quiet.length > 0 && (
          <Fact label="Quiet" title={quietTitle}>
            <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-amber-500" aria-hidden="true" />
            <span className="min-w-0 truncate">{showQuiet.map((r) => r.name).join(', ')}</span>
            {quiet.length > showQuiet.length && <span className="shrink-0 text-xs font-normal text-stone-400">+{quiet.length - showQuiet.length}</span>}
          </Fact>
        )}
      </dl>
      <div className={`hidden gap-x-6 border-y border-stone-200/60 px-5 text-xs font-medium text-stone-400 ${earning.length ? 'sm:grid' : ''} ${COLS} h-9 items-center`}>
        <span>Site or app</span>
        <span className="text-right">Revenue</span>
        <span className="text-right" title={MRR_NOTE}>
          MRR
        </span>
        <span className="text-right">New customers</span>
        <span className="text-right">Visitors</span>
        <span title="Weekly revenue, or visitors without revenue, over the last 8 full weeks">8 weeks</span>
        <span title={STATUS_NOTE}>Status</span>
      </div>
      <ul className={`${entrance} divide-y divide-stone-200/60 sm:border-t-0`}>
        {earning.map((s) => (
          <RankRow key={s.id} site={s} period={period} minBase={minBase} tz={tz} />
        ))}
      </ul>
      {idle.length > 0 && <NoRevenue sites={idle} period={period} first={earning.length === 0} />}
    </section>
  );
});

function NoRevenue({ sites, period, first }: { sites: SiteRow[]; period: string; first: boolean }) {
  return (
    <div className={`px-5 pb-5 pt-4 ${first ? '' : 'border-t border-stone-200/60'}`}>
      <div className="pb-2.5 text-micro uppercase text-stone-400">No revenue · {sites.length}</div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
        {sites.map((s) => {
          const h = s.product ? headlineOf(s.product) : null;
          const n = h ? h.value : s.current.visitors;
          const what = h ? h.label.toLowerCase() : 'visitors';
          const quiet = s.trend.status === 'quiet';
          return (
            <li key={s.id}>
              <button
                {...prefetchProps(`/site/${s.id}?period=${period}`)}
                onClick={() => navigate(`/site/${s.id}?period=${period}`)}
                title={`${s.name}: ${fmtNumber(n)} ${what}, ${statusLabel(s.trend.status).toLowerCase()}`}
                className="card-inset flex h-10 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors duration-fast hover:border-stone-300/80 hover:bg-stone-100"
              >
                <SiteIcon site={s} size={16} />
                <span className={`min-w-0 flex-1 truncate ${quiet ? 'text-stone-500' : 'font-medium text-ink'}`}>{s.name}</span>
                {quiet && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    title={`Quiet: no visit or app session for ${TREND_RULES.quietHours} hours`}
                    role="img"
                    aria-label={`Quiet: no visit or app session for ${TREND_RULES.quietHours} hours`}
                  />
                )}
                <span className={`shrink-0 tabular-nums ${n ? 'text-ink' : 'text-stone-400'}`}>{fmtNumber(n)}</span>
                <span className="shrink-0 text-[11px] text-stone-400">{what}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const RankRow = memo(function RankRow({ site: s, period, minBase, tz }: { site: SiteRow; period: string; minBase: number; tz: string }) {
  const c = s.current;
  const p = s.previous;
  const paid = s.payments !== false;
  const rev = c.revenue[s.currency] ?? 0;
  const quiet = s.trend.status === 'quiet';
  const dash = (
    <span className="text-stone-300" title="Not measured here">
      –
    </span>
  );
  const cell = 'hidden items-baseline justify-end gap-2 tabular-nums sm:flex';
  // Home counts days in the viewer's timezone, the site's page in the site's: the totals can differ (HowCounted).
  const otherTz = paid && s.timezone && s.timezone !== tz ? `${s.name}'s own page counts days in ${s.timezone} time and Home in ${tz} time, so its revenue there can differ.` : null;
  const headline = s.product ? headlineOf(s.product) : null;
  return (
    <li>
      <button
        {...prefetchProps(`/site/${s.id}?period=${period}`)}
                onClick={() => navigate(`/site/${s.id}?period=${period}`)}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-5 py-3 text-left text-[13px] transition-colors duration-fast hover:bg-stone-50 sm:min-h-10 sm:gap-x-6 sm:py-1.5 ${COLS}`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <SiteIcon site={s} size={20} />
          <span className="min-w-0">
            <span className={`block truncate text-sm font-medium sm:text-[13px] ${quiet ? 'text-stone-500' : 'text-ink'}`}>{s.name}</span>
            {/* Narrow screens: the revenue and its change, and the MRR change, under the name. */}
            <span className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-stone-500 sm:hidden">
              {paid ? (
                <>
                  <span className="whitespace-nowrap">
                    <span className="font-medium text-ink">{money(rev, s.currency, true)}</span> <RevenueChange site={s} />
                  </span>
                  {s.subscriptions && (
                    <span className="whitespace-nowrap">
                      MRR <MrrChange site={s} />
                    </span>
                  )}
                </>
              ) : (
                <>
                  {headline ? (
                    // An extension or a newsletter: its headline number, such as "Weekly active 1,240 +4%".
                    <span className="whitespace-nowrap">
                      {headline.label} {fmtNumber(headline.value)} <Change cur={headline.value} prev={headline.previous} minBase={minBase} />
                    </span>
                  ) : (
                    s.goal && (
                      <span className="whitespace-nowrap">
                        {s.goal.label} {fmtNumber(s.goal.count)} <Change cur={s.goal.count} prev={s.goal.previous} minBase={minBase} />
                      </span>
                    )
                  )}
                  {!s.product && <span className="whitespace-nowrap">{`${fmtNumber(c.visitors)} visitors`}</span>}
                </>
              )}
            </span>
          </span>
        </span>
        <span className={cell}>
          {paid ? (
            <>
              <span className="font-medium text-ink">{money(rev, s.currency, true)}</span>
              <RevenueChange site={s} />
              {otherTz && (
                <span className="self-center" title={otherTz} aria-label={otherTz}>
                  <InfoIcon size={12} />
                </span>
              )}
            </>
          ) : s.product ? (
            // No revenue: an extension or a newsletter leads with its own number (Settings, Product type).
            <ProductCell product={s.product} minBase={minBase} />
          ) : s.goal ? (
            // No revenue: the primary goal is the headline (Settings, Primary goal).
            <GoalCell goal={s.goal} minBase={minBase} />
          ) : (
            dash
          )}
        </span>
        <span className={cell} title={s.subscriptions ? MRR_NOTE : undefined}>
          {s.subscriptions ? (
            <>
              <span className="text-ink">{money(s.subscriptions.mrr, s.currency, true)}</span>
              <MrrChange site={s} />
            </>
          ) : (
            dash
          )}
        </span>
        <span className={cell}>
          {paid ? (
            <>
              <span className={c.customers ? 'text-ink' : 'text-stone-400'}>{fmtNumber(c.customers)}</span>
              <Change cur={c.customers} prev={p.customers} minBase={minBase} />
            </>
          ) : (
            dash
          )}
        </span>
        <span className={cell}>
          <span className={c.visitors ? 'text-ink' : 'text-stone-400'}>{fmtNumber(c.visitors)}</span>
          <Change cur={c.visitors} prev={p.visitors} minBase={minBase} noData={p.sessions === 0 && !p.visitors} />
        </span>
        <span className="flex items-center">
          <WeekSpark site={s} />
        </span>
        <span className="flex flex-col items-end gap-0.5 justify-self-end sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2 sm:justify-self-start">
          <TrendChip status={s.trend.status} />
          <DownWeeks site={s} />
        </span>
      </button>
    </li>
  );
});

/** The headline of an extension or a newsletter without revenue in a ranked row: "Weekly active 1,240 +4%". */
function ProductCell({ product, minBase }: { product: ProductNumbers; minBase: number }) {
  const h = headlineOf(product);
  return (
    <>
      <span className="min-w-0 truncate text-xs text-stone-500" title={METRIC_NOTE[h.key]}>
        {h.label}
      </span>
      <span className="font-medium text-ink">{fmtNumber(h.value)}</span>
      <Change cur={h.value} prev={h.previous} minBase={minBase} />
    </>
  );
}

/** The primary goal in a ranked row of a site without revenue: "Signups 41 −12%". */
function GoalCell({ goal, minBase }: { goal: SiteGoal; minBase: number }) {
  return (
    <>
      <span className="min-w-0 truncate text-xs text-stone-500" title={`Primary goal: ${goal.name}. Visitors who reached it.`}>
        {goal.label}
      </span>
      <span className="font-medium text-ink">{fmtNumber(goal.count)}</span>
      <Change cur={goal.count} prev={goal.previous} minBase={minBase} />
    </>
  );
}

/** "down 3 weeks" next to the status chip when the last 2 or more full weeks each ended below the week before. */
function DownWeeks({ site }: { site: SiteRow }) {
  const n = site.weeksDeclining ?? 0;
  if (n < 2) return null;
  const revenue = site.payments !== false && (site.weekly ?? []).some((w) => w.revenue > 0);
  const what = revenue ? 'revenue' : 'visitors';
  const text = `Weekly ${what} fell ${n} weeks in a row, up to last week.`;
  return (
    <span className="whitespace-nowrap text-xs font-medium text-red-600" title={text}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">down {n} weeks</span>
    </span>
  );
}
