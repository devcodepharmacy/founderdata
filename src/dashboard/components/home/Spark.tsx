import { memo, useId, useMemo } from 'react';
import { fmtNumber } from '../../lib/format';
import { money, shortDate } from './shared';
import type { SiteRow } from './types';

// Small SVG charts for Home. Each draws in once from the left (fd-wipe on a clip, a transform), so ten cards cost ten
// SVGs instead of ten Recharts trees. Scales start at 0: a site with 40 to 44 visitors does not look like a spike.

const wipe = { transformOrigin: 'left', animation: 'fd-wipe var(--dur-slower) var(--ease-out) both' } as const;

/** An area from 0 to the series max, colored by `currentColor`. Fills its parent's width. */
export const AreaSpark = memo(function AreaSpark({ values, height, label, className = '', dot = false }: { values: number[]; height: number; label?: string; className?: string; dot?: boolean }) {
  const id = useId().replace(/:/g, '');
  const W = 100;
  const H = height;
  const shape = useMemo(() => {
    if (values.length < 2) return null;
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 1.5 - (Math.max(0, v) / max) * (H - 4)] as const);
    // A soft curve: each segment bends through the midpoint, which keeps peaks where the data is.
    let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const mx = (x0 + x1) / 2;
      d += `C${mx.toFixed(2)},${y0.toFixed(2)} ${mx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
    }
    return { line: d, area: `${d}L${W},${H}L0,${H}Z`, last: pts[pts.length - 1] };
  }, [values, H]);
  if (!shape) return <div className={className} style={{ height }} aria-hidden="true" />;
  return (
    <div className={`relative ${className}`} style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}c`}>
            <rect x="-2" y="-4" width={W + 4} height={H + 8} style={wipe} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}c)`}>
          <path d={shape.area} fill={`url(#${id}f)`} />
          <path d={shape.line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
      {dot && (
        <span
          className="absolute h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-white"
          style={{ left: `${shape.last[0]}%`, top: `${(shape.last[1] / H) * 100}%`, animation: 'fd-fade var(--dur-base) var(--ease-out) var(--dur-slower) both' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
});

/** Revenue per bucket as thin bars from 0, colored by `currentColor`. They wipe in from the left once. */
export const BarStrip = memo(function BarStrip({ values, height, className = '' }: { values: number[]; height: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const W = 100;
  const H = height;
  const bars = useMemo(() => {
    const max = Math.max(1, ...values);
    const step = W / Math.max(1, values.length);
    const w = Math.max(0.6, step * 0.62);
    return values.map((v, i) => {
      const h = v > 0 ? Math.max(1.5, (v / max) * H) : 0;
      return { x: i * step + (step - w) / 2, w, h };
    });
  }, [values, H]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`block w-full ${className}`} style={{ height }} aria-hidden="true">
      <defs>
        <clipPath id={`${id}c`}>
          <rect x="-2" y="-2" width={W + 4} height={H + 4} style={wipe} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        {bars.map((b, i) => (b.h ? <rect key={i} x={b.x} y={H - b.h} width={b.w} height={b.h} rx={0.6} fill="currentColor" /> : null))}
      </g>
    </svg>
  );
});

/**
 * Weekly revenue, or visitors on a site without revenue, over the last 8 full weeks. Red end dot when the last weeks
 * fell in a row (falling in src/worker/home.ts).
 */
export const WeekSpark = memo(function WeekSpark({ site }: { site: SiteRow }) {
  const id = useId().replace(/:/g, '');
  const weeks = site.weekly ?? [];
  if (weeks.length < 2) return <span className="text-stone-300">–</span>;
  const revenue = site.payments !== false && weeks.some((w) => w.revenue > 0);
  const v = weeks.map((w) => Math.max(0, revenue ? w.revenue : w.visitors));
  const max = Math.max(1, ...v);
  const W = 72;
  const H = 22;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * (W - 4) + 2, H - 3 - (x / max) * (H - 6)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  const fmt = (x: number) => (revenue ? money(x, site.currency, true) : fmtNumber(x));
  const label = `Weekly ${revenue ? 'revenue' : 'visitors'}, the 8 full weeks from ${shortDate(Date.parse(weeks[0].week))}: ${v.map(fmt).join(', ')}`;
  const falling = !!site.falling;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={`shrink-0 overflow-visible ${revenue ? 'text-revenue' : 'text-visitors'}`}>
      <title>{label}</title>
      <defs>
        <clipPath id={`${id}c`}>
          <rect x="-2" y="-4" width={W + 4} height={H + 8} style={wipe} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <polygon points={`2,${H - 3} ${line} ${W - 2},${H - 3}`} fill="currentColor" opacity={0.14} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      </g>
      <circle cx={lx} cy={ly} r={2.4} className={falling ? 'fill-red-500' : ''} fill={falling ? undefined : 'currentColor'} style={{ animation: 'fd-fade var(--dur-base) var(--ease-out) var(--dur-slower) both' }} />
    </svg>
  );
});
