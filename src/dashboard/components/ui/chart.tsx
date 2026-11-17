import type { ReactNode } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * Recharts in the house style, two lines per chart:
 *
 *   <CartesianGrid {...chartGrid} />  <XAxis dataKey="day" {...chartXAxis} />  <YAxis {...chartYAxis} />
 *   <Tooltip {...chartTooltip} content={...<ChartTooltip .../>} />  <Area {...chartAnim} ... fill="url(#fd-visitors)" />
 *
 * and {chartDefs()} as a direct child of the chart for the gradient fills. Colors come from CSS variables, so every
 * chart follows the theme without a re-render.
 */

/** Gradient fills, by id: fd-visitors, fd-revenue, fd-brand (areas), fd-revenue-bar (bars). Call it, do not render it. */
export function chartDefs() {
  const area = (id: string, color: string, top = 0.24) => (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={color} stopOpacity={top} />
      <stop offset="1" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
  return (
    <defs>
      {area('fd-visitors', 'rgb(var(--visitors))')}
      {area('fd-revenue', 'rgb(var(--revenue))')}
      {area('fd-brand', 'rgb(var(--brand))', 0.2)}
      <linearGradient id="fd-revenue-bar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgb(var(--revenue))" stopOpacity={1} />
        <stop offset="1" stopColor="rgb(var(--revenue))" stopOpacity={0.72} />
      </linearGradient>
    </defs>
  );
}

const tick = { fill: 'var(--chart-axis)', fontSize: 11, fontFamily: 'inherit' };

/** Horizontal hairlines only. */
export const chartGrid = { vertical: false, stroke: 'var(--chart-grid)' } as const;
/** No axis line or ticks, muted 11 px labels, a little air under the plot. */
export const chartXAxis = { axisLine: false, tickLine: false, tick, tickMargin: 8, minTickGap: 24 } as const;
export const chartYAxis = { axisLine: false, tickLine: false, tick, width: 44, tickMargin: 4 } as const;
/** The hover band and a tooltip that follows without lag. */
export const chartTooltip = {
  cursor: { fill: 'var(--chart-cursor)', stroke: 'var(--chart-cursor-line)', strokeWidth: 0 },
  isAnimationActive: false,
  wrapperStyle: { outline: 'none', zIndex: 20 },
} as const;
/** For a line chart's tooltip: a vertical hairline instead of a band. */
export const chartLineCursor = { stroke: 'var(--chart-cursor-line)', strokeWidth: 1 } as const;

/**
 * Draw-in for series: 320 ms from the baseline on first render, off under reduced motion. Recharts animates the shape
 * itself here (a path, not a transform); it is the one sanctioned exception, because it runs once per data change.
 */
export function chartAnim() {
  const off = prefersReducedMotion();
  return { isAnimationActive: !off, animationDuration: 320, animationEasing: 'ease-out' as const };
}

/** Line and area series style: 2 px, rounded, a ringed dot on hover. */
export const chartLine = (color: string) => ({
  stroke: color,
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  dot: false,
  activeDot: { r: 4, strokeWidth: 2, stroke: 'var(--chart-dot-ring)', fill: color },
});

export interface TooltipRow {
  label: ReactNode;
  value: ReactNode;
  /** A CSS color for the swatch: 'rgb(var(--visitors))'. */
  color?: string;
  muted?: boolean;
}

/** The shared tooltip box: a title (the day) and aligned rows with swatches. Use it as a Recharts Tooltip content. */
export function ChartTooltip({ title, rows, footer }: { title: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="pop min-w-[168px] px-3 py-2.5 text-xs" style={{ animation: 'fd-fade var(--dur-fast) var(--ease-out) both' }}>
      <div className="mb-1.5 font-medium text-stone-500">{title}</div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className={`flex items-center gap-2 ${r.muted ? 'text-stone-400' : 'text-ink'}`}>
            {r.color && <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: r.color }} aria-hidden="true" />}
            <span className="text-stone-500">{r.label}</span>
            <span className="ml-auto pl-4 font-medium tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-2 border-t border-stone-200/70 pt-2 text-stone-400">{footer}</div>}
    </div>
  );
}

/** The series colors as CSS values, for Recharts props and ChartTooltip swatches. */
export const SERIES = {
  visitors: 'rgb(var(--visitors))',
  revenue: 'rgb(var(--revenue))',
  brand: 'rgb(var(--brand-text))',
  muted: 'rgb(var(--stone-400))',
} as const;
