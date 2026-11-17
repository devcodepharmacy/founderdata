import { useId, useMemo } from 'react';

export type SeriesTone = 'visitors' | 'revenue' | 'brand' | 'muted';
const STROKE: Record<SeriesTone, string> = {
  visitors: 'rgb(var(--visitors))',
  revenue: 'rgb(var(--revenue))',
  brand: 'rgb(var(--brand-text))',
  muted: 'rgb(var(--stone-400))',
};

/**
 * A small line of a series with a soft fill under it, for a stat tile or a table row. It draws in once from the left
 * (a transform on a clip, 320 ms). Nulls are gaps. It fills its parent's width; pass the height.
 */
export function Sparkline({
  values,
  tone = 'visitors',
  height = 32,
  fill = true,
  dot = true,
  className = '',
  label,
}: {
  values: (number | null)[];
  tone?: SeriesTone;
  height?: number;
  fill?: boolean;
  /** A dot on the last value. */
  dot?: boolean;
  className?: string;
  /** Read out by screen readers, such as "Visitors, last 30 days, rising". Without it the line is decorative. */
  label?: string;
}) {
  const id = useId().replace(/:/g, '');
  const W = 100;
  const H = height;
  const { line, area, last } = useMemo(() => {
    const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (nums.length < 2) return { line: '', area: '', last: null as null | [number, number] };
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const pad = 2.5;
    const x = (i: number) => (i / (values.length - 1)) * W;
    const y = (v: number) => pad + (1 - (v - min) / span) * (H - pad * 2);
    let d = '';
    let pen = false;
    let lastPt: [number, number] | null = null;
    let firstX = 0;
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return void (pen = false);
      if (!d) firstX = x(i);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
      pen = true;
      lastPt = [x(i), y(v)];
    });
    const lp = lastPt as [number, number] | null;
    return { line: d, area: lp ? `${d}L${lp[0].toFixed(2)},${H}L${firstX.toFixed(2)},${H}Z` : '', last: lp };
  }, [values, H]);

  if (!line) return <div className={className} style={{ height }} aria-hidden="true" />;
  const color = STROKE[tone];
  return (
    <div className={`relative ${className}`} style={{ height }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}c`}>
            <rect x="-2" y="-4" width={W + 4} height={H + 8} style={{ transformOrigin: 'left', animation: 'fd-wipe var(--dur-slower) var(--ease-out) both' }} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}c)`}>
          {fill && <path d={area} fill={`url(#${id}f)`} />}
          <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
      {/* The dot sits outside the stretched SVG so it stays round. */}
      {dot && last && (
        <span
          className="absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white"
          style={{ left: `${last[0]}%`, top: `${(last[1] / H) * 100}%`, background: color, animation: 'fd-fade var(--dur-base) var(--ease-out) var(--dur-slower) both' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
