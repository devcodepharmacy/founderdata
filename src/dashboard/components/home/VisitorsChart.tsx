import { memo, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { bucketLabel, fmtNumber } from '../../lib/format';
import { chartAnim, chartDefs, chartGrid, chartLine, chartLineCursor, chartTooltip, chartXAxis, chartYAxis, ChartTooltip, SERIES } from '../ui';
import type { HomeData } from './types';

/** Visitors across all sites, per bucket. Revenue has its own chart in the money card, never a second y-axis here. */
export const VisitorsChart = memo(function VisitorsChart({ series, granularity }: { series: HomeData['series']; granularity: HomeData['range']['granularity'] }) {
  const rows = useMemo(() => series.map((b) => ({ bucket: b.bucket, visitors: b.visitors })), [series]);
  const total = useMemo(() => rows.reduce((t, r) => t + r.visitors, 0), [rows]);
  const peak = useMemo(() => rows.reduce((m, r) => (r.visitors > m.visitors ? r : m), rows[0] ?? { bucket: '', visitors: 0 }), [rows]);
  return (
    <section className="card p-5" aria-labelledby="visitors-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="visitors-title" className="flex items-center gap-2 text-title">
          <span className="h-2 w-2 rounded-[3px] bg-visitors" aria-hidden="true" />
          Visitors, all sites
        </h2>
        {total > 0 && (
          <p className="text-xs text-stone-500">
            Busiest {granularity}: <span className="font-medium text-ink">{bucketLabel(peak.bucket, granularity, true)}</span>, {fmtNumber(peak.visitors)} visitors
          </p>
        )}
      </div>
      <div className="mt-4 h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
            {chartDefs()}
            <CartesianGrid {...chartGrid} />
            <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, granularity)} {...chartXAxis} />
            <YAxis {...chartYAxis} allowDecimals={false} tickFormatter={(v) => fmtNumber(v)} />
            <Tooltip
              {...chartTooltip}
              cursor={chartLineCursor}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <ChartTooltip title={bucketLabel(payload[0].payload.bucket, granularity, true)} rows={[{ label: 'Visitors', value: fmtNumber(payload[0].payload.visitors), color: SERIES.visitors }]} />
                ) : null
              }
            />
            <Area type="monotone" dataKey="visitors" fill="url(#fd-visitors)" {...chartLine(SERIES.visitors)} {...chartAnim()} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});
