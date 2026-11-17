import { useState } from 'react';
import { navigate } from '../App';
import { useDash } from '../lib/context';
import { fmtNumber } from '../lib/format';
import { contentPageUrl } from '../lib/paths';
import { Card, ErrorLine, Row, Table, useSiteApi } from './site/primitives';
import { EmptyIcons, EmptyState } from './ui/EmptyState';
import { Segmented } from './ui/Segmented';
import { Skeleton } from './ui/Skeleton';
import { StatStrip, StatTile } from './ui/StatTile';

// Core Web Vitals from real visitors: GET /api/sites/:id/vitals (src/worker/vitals.ts, docs/API.md).

type Metric = 'lcp' | 'inp' | 'cls' | 'ttfb' | 'fcp';
type Rating = 'good' | 'needs_improvement' | 'poor';
interface MetricSummary {
  p75: number | null;
  samples: number;
  good: number | null;
  needs_improvement: number | null;
  poor: number | null;
  rating: Rating | null;
}
type Group = { page_loads: number } & Record<Metric, MetricSummary>;
interface Vitals {
  days: number;
  path: string | null;
  sample_rate: number;
  min_sample: number;
  thresholds: Record<Metric, { good: number; poor: number; unit: 'ms' | 'score' }>;
  overall: Group;
  devices: ({ device: string } & Group)[];
  pages?: ({ path: string } & Group)[];
  total_pages?: number;
}

const METRICS: { id: Metric; label: string; name: string }[] = [
  { id: 'lcp', label: 'LCP', name: 'Largest Contentful Paint: when the main content shows' },
  { id: 'inp', label: 'INP', name: 'Interaction to Next Paint: how long a tap or click takes to show a response' },
  { id: 'cls', label: 'CLS', name: 'Cumulative Layout Shift: how much the page jumps while it loads' },
  { id: 'fcp', label: 'FCP', name: 'First Contentful Paint: when the first text or image shows' },
  { id: 'ttfb', label: 'TTFB', name: 'Time to First Byte: how long the server takes to answer' },
];
const TONE: Record<Rating, string> = { good: 'text-emerald-700', needs_improvement: 'text-amber-700', poor: 'text-red-600' };
const BAR: Record<Rating, string> = { good: 'bg-emerald-500', needs_improvement: 'bg-amber-400', poor: 'bg-red-500' };
const RATING_LABEL: Record<Rating, string> = { good: 'Good', needs_improvement: 'Needs work', poor: 'Poor' };

export function fmtVital(m: Metric, v: number | null): string {
  if (v === null) return '–';
  if (m === 'cls') return v.toFixed(2);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

function Value({ m, s, min, tile = false }: { m: Metric; s: MetricSummary; min: number; tile?: boolean }) {
  if (s.p75 === null || !s.rating) {
    return (
      <span className={`text-stone-400 ${tile ? 'text-[15px] font-medium' : ''}`} title={`A p75 needs ${min} loads that report ${m.toUpperCase()}.`}>
        {s.samples ? `${fmtNumber(s.samples)} of ${min}` : '–'}
      </span>
    );
  }
  return (
    <span className={`font-medium ${TONE[s.rating]}`} title={`${RATING_LABEL[s.rating]}, from ${fmtNumber(s.samples)} page loads`}>
      {fmtVital(m, s.p75)}
    </span>
  );
}

/** Good, needs work and poor as one bar. */
function Shares({ s }: { s: MetricSummary }) {
  if (s.good === null || s.needs_improvement === null || s.poor === null) return <div className="h-1 w-full rounded-full bg-stone-100" />;
  const parts: [Rating, number][] = [
    ['good', s.good],
    ['needs_improvement', s.needs_improvement],
    ['poor', s.poor],
  ];
  return (
    <div
      className="flex h-1 w-full overflow-hidden rounded-full bg-stone-100"
      title={parts.map(([r, v]) => `${RATING_LABEL[r]} ${Math.round(v * 100)}%`).join(', ')}
    >
      {parts.map(([r, v]) => (
        <div key={r} className={BAR[r]} style={{ width: `${v * 100}%` }} />
      ))}
    </div>
  );
}

function Overall({ data }: { data: Vitals }) {
  const t = data.thresholds;
  return (
    <StatStrip columns={5} label="Core Web Vitals">
      {METRICS.map((m) => {
        const s = data.overall[m.id];
        return (
          <StatTile
            key={m.id}
            label={<span title={m.name}>{m.label}</span>}
            info={s.rating ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BAR[s.rating]}`} aria-hidden="true" /> : undefined}
            value={null}
            display={<Value m={m.id} s={s} min={data.min_sample} tile />}
            sub={`good up to ${fmtVital(m.id, t[m.id].good)}`}
            footer={
              <span className="mt-1 block w-full">
                <Shares s={s} />
              </span>
            }
          />
        );
      })}
    </StatStrip>
  );
}

function Empty({ data }: { data: Vitals }) {
  return (
    <EmptyState compact className="!py-6" icon={EmptyIcons.chart} title={data.sample_rate === 0 ? 'Page speed is off' : 'No page loads measured yet'}>
      {data.sample_rate === 0
        ? 'Turn it on in Settings, Daily write cap.'
        : data.path
          ? `None for ${data.path} in the last ${data.days} days.`
          : `The tracker reports them as visitors leave a page.`}
    </EmptyState>
  );
}

/**
 * The page speed card: the 75th percentile of each Core Web Vital over 28 days, per device, and per page for the whole
 * site. With `path`, one page.
 */
export function WebVitalsCard({ path }: { path?: string }) {
  const { site } = useDash();
  const [by, setBy] = useState<'pages' | 'devices'>('pages');
  const { data, error, retry } = useSiteApi<Vitals>(`/api/sites/${site.id}/vitals?limit=10${path ? `&path=${encodeURIComponent(path)}` : ''}`);
  const split = path ? 'devices' : by;
  const rows: ({ label: string; path?: string } & Group)[] =
    split === 'devices' ? (data?.devices ?? []).map((d) => ({ label: d.device, ...d })) : (data?.pages ?? []).map((p) => ({ label: p.path, ...p }));

  return (
    <Card
      title="Page speed"
      right={
        data && data.overall.page_loads > 0 ? (
          <span className="text-xs text-stone-500">
            {fmtNumber(data.overall.page_loads)} page loads, last {data.days} days
            {data.sample_rate < 100 ? `, ${data.sample_rate}% sampled` : ''}
          </span>
        ) : undefined
      }
      info={`Core Web Vitals measured in visitors' browsers. Each number is the 75th percentile, colored by Google's thresholds. Below ${data?.min_sample ?? 20} page loads a metric shows its count instead. Safari and Firefox report fewer metrics than Chrome, and INP needs a tap or click.`}
      infoLabel="How page speed is measured"
    >
      {error && !data ? (
        <ErrorLine error={error} retry={retry} />
      ) : !data ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading</span>
          <StatStrip columns={5}>
            {Array.from({ length: 5 }, (_, i) => (
              <StatTile key={i} label={<Skeleton className="h-3.5 w-10" />} value={undefined} loading />
            ))}
          </StatStrip>
        </div>
      ) : data.overall.page_loads === 0 ? (
        <Empty data={data} />
      ) : (
        <div className="flex flex-col gap-4">
          <Overall data={data} />
          {!path && (
            <Segmented
              size="sm"
              className="self-start"
              label="Split page speed by"
              value={by}
              onChange={setBy}
              options={[
                { value: 'pages', label: 'Pages' },
                { value: 'devices', label: 'Devices' },
              ]}
            />
          )}
          {rows.length > 0 && (
            <Table head={[split === 'devices' ? 'Device' : 'Page', 'Loads', ...METRICS.slice(0, 3).map((m) => m.label)]}>
              {rows.map((r) => (
                <Row
                  key={r.label}
                  onClick={r.path ? () => navigate(contentPageUrl(site.id, r.path!)) : undefined}
                  title={r.path ? `Open ${r.path}` : undefined}
                  cells={[
                    <span className="truncate">{r.label}</span>,
                    fmtNumber(r.page_loads),
                    ...METRICS.slice(0, 3).map((m) => <Value key={m.id} m={m.id} s={r[m.id]} min={data.min_sample} />),
                  ]}
                />
              ))}
            </Table>
          )}
          {split === 'pages' && data.total_pages !== undefined && data.total_pages > rows.length && (
            <p className="text-xs text-stone-500">
              The {rows.length} most loaded of {fmtNumber(data.total_pages)} measured pages.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
