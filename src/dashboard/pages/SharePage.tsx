import { useEffect, useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Favicon } from '../components/Icons';
import { LogoMark } from '../components/Logo';
import { renderLabel } from '../components/Panel';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  ChartTooltip,
  EmptyIcons,
  EmptyState,
  SERIES,
  SkeletonChart,
  SkeletonRows,
  StatStrip,
  StatTile,
  StatusChip,
  Stagger,
  StickyBar,
  Tabs,
  chartAnim,
  chartDefs,
  chartGrid,
  chartLine,
  chartTooltip,
  chartXAxis,
  chartYAxis,
} from '../components/ui';
import { api, type BreakdownRow, type Overview } from '../lib/api';
import { bucketLabel, fmtDuration, fmtMoney, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';

/** GET /api/share/:token (src/worker/share.ts). */
interface ShareInfo {
  site: { name: string; domain: string; timezone: string; currency: string; app: boolean };
  label: string | null;
  showRevenue: boolean;
  decimals: number;
  dims: string[];
}

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const PANELS: { label: string; dim: string }[][] = [
  [
    { label: 'Channel', dim: 'channel' },
    { label: 'Referrer', dim: 'source' },
    { label: 'Campaign', dim: 'campaign' },
  ],
  [
    { label: 'Page', dim: 'page' },
    { label: 'Entry page', dim: 'entry_page' },
  ],
  [
    { label: 'Country', dim: 'country' },
    { label: 'Region', dim: 'region' },
    { label: 'City', dim: 'city' },
  ],
  [
    { label: 'Browser', dim: 'browser' },
    { label: 'OS', dim: 'os' },
    { label: 'Device', dim: 'device' },
  ],
];

type Money = (minor: number, compact?: boolean) => string;

/** GET /api/share/:token/overview: `mrr` comes with a link that shows revenue, for a site with subscriptions, unfiltered. */
type ShareOverviewData = Overview & { mrr?: { mrr: number; mrrStart: number; active: number } | null };

/** The change against the period before, as a fraction; null without a base. */
const change = (cur: number, prev: number | undefined) => (prev ? (cur - prev) / prev : null);

function SharePanel({ token, period, tabs, money }: { token: string; period: string; tabs: { label: string; dim: string }[]; money: Money | null }) {
  const [dim, setDim] = useState(tabs[0].dim);
  const [all, setAll] = useState(false);
  const { data, error, loading } = useApi<BreakdownRow[]>(`/api/share/${token}/breakdown?dim=${dim}&period=${period}`);
  const rows = useMemo(() => [...(data ?? [])].sort((a, b) => b.visitors - a.visitors), [data]);
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  // A view where no row earned anything shows no revenue column.
  const earns = !!money && rows.some((r) => r.revenue > 0);
  return (
    <div className="card flex min-h-[220px] min-w-0 flex-col p-3">
      <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
        <Tabs label="Breakdown" items={tabs.map((t) => ({ value: t.dim, label: t.label }))} value={dim} onChange={(d) => (setDim(d), setAll(false))} className="min-w-0 overflow-x-auto" />
        <div className="flex shrink-0 items-center self-end pr-2.5 text-xs font-medium text-stone-400 sm:self-auto lg:self-end xl:self-auto">
          <span className="flex w-16 items-center justify-end gap-1">
            <span className="h-2 w-2 rounded-[3px] bg-visitors" aria-hidden="true" />
            Visitors
          </span>
          {earns && (
            <span className="flex w-[76px] items-center justify-end gap-1">
              <span className="h-2 w-2 rounded-[3px] bg-revenue" aria-hidden="true" />
              Revenue
            </span>
          )}
        </div>
      </div>
      <div className={`flex-1 space-y-0.5 transition-opacity duration-base ${loading && data ? 'opacity-60' : ''}`}>
        {error && <p className="p-3 text-sm text-red-600">{error}</p>}
        {!data && !error && <SkeletonRows rows={6} />}
        {data && rows.length === 0 && <EmptyState compact icon={EmptyIcons.chart} title="No visits in this period" />}
        {rows.slice(0, all ? undefined : 10).map((r, i) => (
          <div key={`${r.label}-${i}`} className="relative flex h-9 items-center rounded-lg">
            <div className="absolute inset-y-0 left-0 origin-left rounded-lg bg-visitorsSoft" style={{ width: `${(r.visitors / max) * 100}%`, minWidth: r.visitors ? 4 : 0 }} />
            <div className="relative flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-sm">
              {r.appStore || r.noVisit ? <span className="truncate">{r.label}</span> : renderLabel(dim, r)}
            </div>
            <div className="relative flex shrink-0 items-center pr-2.5 text-sm tabular-nums">
              <span className="w-16 text-right font-medium">{r.visitors ? fmtNumber(r.visitors) : <span className="text-stone-300">–</span>}</span>
              {earns && money && <span className="w-[76px] text-right text-stone-500">{r.revenue ? money(r.revenue, true) : <span className="text-stone-300">–</span>}</span>}
            </div>
          </div>
        ))}
      </div>
      {rows.length > 10 && !all && (
        <div className="mt-auto flex min-h-8 items-center justify-end pt-2">
          <button className="rounded-md px-2 py-1 text-xs font-medium text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink" onClick={() => setAll(true)}>
            Show all {fmtNumber(rows.length)}
          </button>
        </div>
      )}
    </div>
  );
}

/** "+$450 in this period", "no change in this period". */
function mrrNote(m: { mrr: number; mrrStart: number }, money: Money) {
  const d = m.mrr - m.mrrStart;
  return d === 0 ? '' : `${d > 0 ? '+' : '-'}${money(Math.abs(d), true)} in this period`;
}

function ShareOverview({ data, money }: { data: ShareOverviewData | null; money: Money | null }) {
  const c = data?.current;
  const p = data?.previous;
  const g = data?.range.granularity ?? 'day';
  const mrr = money && data?.mrr ? data.mrr : null;
  const loading = !c;
  const tiles = [
    <StatTile key="v" label="Visitors" tone="visitors" value={c?.visitors} format={fmtNumber} change={c ? change(c.visitors, p?.visitors) : null} loading={loading} />,
    <StatTile key="p" label="Pageviews" value={c?.pageviews} format={fmtNumber} change={c ? change(c.pageviews, p?.pageviews) : null} loading={loading} />,
    ...(money ? [<StatTile key="r" label="Revenue" tone="revenue" value={c?.revenue} format={(n) => money(n, true)} change={c ? change(c.revenue, p?.revenue) : null} loading={loading} />] : []),
    ...(mrr && money
      ? [
          <StatTile
            key="m"
            label="MRR"
            tone="revenue"
            value={mrr.mrr}
            format={(n) => money(n, true)}
            footer={mrrNote(mrr, money) && <span className="text-xs text-stone-500" title={`Monthly recurring revenue from ${fmtNumber(mrr.active)} paying ${mrr.active === 1 ? 'subscription' : 'subscriptions'} at the end of the period. A yearly plan counts as a twelfth.`}>{mrrNote(mrr, money)}</span>}
          />,
        ]
      : []),
    ...(money ? [<StatTile key="c" label="Conversion rate" value={c?.conversionRate} format={(n) => fmtPct(n, n >= 0.1 ? 0 : 2)} change={c ? change(c.conversionRate, p?.conversionRate) : null} loading={loading} />] : []),
    <StatTile key="b" label="Bounce rate" value={c?.bounceRate} format={(n) => fmtPct(n)} change={c ? change(c.bounceRate, p?.bounceRate) : null} invertChange loading={loading} />,
    <StatTile key="s" label="Session time" value={c?.avgDuration} format={fmtDuration} change={c ? change(c.avgDuration, p?.avgDuration) : null} loading={loading} />,
  ];
  return (
    <div className="card overflow-hidden">
      <StatStrip flat label="Headline numbers">
        {tiles}
      </StatStrip>
      <div className="h-[300px] px-2 pb-3 pt-6 sm:px-4">
        {!data ? (
          <SkeletonChart height={270} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data.series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              {chartDefs()}
              <CartesianGrid {...chartGrid} />
              <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, g)} {...chartXAxis} />
              <YAxis yAxisId="v" {...chartYAxis} allowDecimals={false} tickFormatter={(v) => fmtNumber(v)} />
              {money && <YAxis yAxisId="r" orientation="right" {...chartYAxis} width={56} tickFormatter={(v) => money(v, true)} domain={[0, (m: number) => Math.max(1, Math.ceil(m * 1.6))]} />}
              <Tooltip
                {...chartTooltip}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as Overview['series'][0];
                  return (
                    <ChartTooltip
                      title={bucketLabel(d.bucket, g, true)}
                      rows={[
                        { label: 'Visitors', value: fmtNumber(d.visitors), color: SERIES.visitors },
                        { label: 'Pageviews', value: fmtNumber(d.pageviews), muted: true },
                        ...(money ? [{ label: 'Revenue', value: money(d.revenue), color: SERIES.revenue }] : []),
                      ]}
                    />
                  );
                }}
              />
              {money && <Bar yAxisId="r" dataKey="revenue" fill="url(#fd-revenue-bar)" radius={[4, 4, 0, 0]} maxBarSize={36} {...chartAnim()} />}
              <Area yAxisId="v" type="monotone" dataKey="visitors" fill="url(#fd-visitors)" {...chartLine(SERIES.visitors)} {...chartAnim()} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/** /share/:token: a read-only dashboard for anyone with the link (src/worker/share.ts). No login. */
export function SharePage({ token }: { token: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [period, setPeriod] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('period');
    return PERIODS.some((x) => x.value === p) ? p! : '30d';
  });
  const { data: overview } = useApi<ShareOverviewData>(info ? `/api/share/${token}/overview?period=${period}` : null);

  useEffect(() => {
    api<ShareInfo>(`/api/share/${token}`).then(setInfo, () => setMissing(true));
  }, [token]);
  // Search engines skip share pages (the server sends X-Robots-Tag too).
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
  useEffect(() => {
    window.history.replaceState(null, '', `${window.location.pathname}?period=${period}`);
  }, [period]);

  if (missing) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24">
        <div className="card">
          <EmptyState icon={EmptyIcons.chart} title="This share link does not work">
            It was revoked, it expired, or the address is not complete. Ask the person who sent it for a new one.
          </EmptyState>
        </div>
      </div>
    );
  }
  const money: Money | null = info?.showRevenue ? (minor, compact) => fmtMoney(minor, info.site.currency, info.decimals, compact) : null;

  return (
    <div className="mx-auto max-w-[1480px] px-3 pb-10 sm:px-6">
      <StickyBar>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 sm:pt-4">
          <div className="flex min-w-0 items-center gap-3">
            {info ? <Favicon domain={info.site.domain} size={30} /> : <span className="h-[30px] w-[30px] rounded-lg bg-stone-100" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-title text-ink">{info?.site.name ?? ' '}</h1>
                {info && <StatusChip tone="neutral" dot={false}>Read-only</StatusChip>}
              </div>
              <div className="truncate text-[13px] text-stone-500">
                {info?.site.domain}
                {info?.label ? ` · ${info.label}` : ''}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select className="input h-9 w-auto py-0 text-[13px] font-medium" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <ThemeToggle />
          </div>
        </div>
      </StickyBar>

      <div className="mt-4">
        <ShareOverview data={info ? overview : null} money={money} />
      </div>
      {info && (
        <Stagger className="mt-4 grid gap-4 lg:grid-cols-2">
          {PANELS.map((tabs) => (
            <SharePanel key={tabs[0].dim} token={token} period={period} tabs={tabs} money={money} />
          ))}
        </Stagger>
      )}

      {info && (
        <p className="mt-10 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-stone-400">
          <LogoMark size={16} />
          <span>
            Read-only stats shared by {info.site.domain} · Times in {info.site.timezone}
            {money ? `, revenue in ${info.site.currency}` : ''} · Made with FounderData
          </span>
        </p>
      )}
    </div>
  );
}
