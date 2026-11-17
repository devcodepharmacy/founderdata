import type { ReactNode } from 'react';
import { ChangeBadge } from './ChangeBadge';
import { NumberTicker } from './NumberTicker';
import { Skeleton } from './Skeleton';
import { Sparkline, type SeriesTone } from './Sparkline';

/**
 * One headline number: a label, the value (counting to each new value), its change against the period before and an
 * optional sparkline. `value` null shows "not measured" as a dash, never a 0. While `loading` with no value yet it
 * holds the same height with skeletons. Use it inside a card or a row of tiles; it has no border of its own.
 */
export function StatTile({
  label,
  value,
  format,
  change,
  invertChange,
  spark,
  tone,
  loading = false,
  info,
  footer,
  onClick,
  active = false,
  className = '',
}: {
  label: ReactNode;
  value: number | null | undefined;
  format?: (n: number) => string;
  change?: number | null;
  /** Lower is better (bounce rate, churn): a fall shows green. */
  invertChange?: boolean;
  spark?: (number | null)[];
  /** The series color: a swatch before the label and the sparkline's color. */
  tone?: SeriesTone;
  loading?: boolean;
  /** An InfoTip or a chip after the label. */
  info?: ReactNode;
  footer?: ReactNode;
  /** Makes the tile a button, for tiles that pick the chart's series. */
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const swatch = tone === 'visitors' ? 'bg-visitors' : tone === 'revenue' ? 'bg-revenue' : tone === 'brand' ? 'bg-brand' : null;
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-stone-500">
        {swatch && <span className={`h-2 w-2 shrink-0 rounded-[3px] ${swatch}`} aria-hidden="true" />}
        <span className="truncate">{label}</span>
        {info}
      </div>
      {loading && (value === null || value === undefined) ? (
        <>
          <Skeleton className="mt-2 h-7 w-24" />
          <Skeleton className="mt-2 h-4 w-12" />
        </>
      ) : (
        <>
          <div className={`mt-1 text-stat text-ink transition-opacity duration-base ${loading ? 'opacity-60' : ''}`}>
            {value === null || value === undefined ? <span className="text-stone-300" title="Not measured">–</span> : <NumberTicker value={value} format={format} />}
          </div>
          <div className="mt-1 flex h-5 items-center gap-2">
            <ChangeBadge change={change} invert={invertChange} />
            {footer}
          </div>
        </>
      )}
      {spark && <Sparkline values={spark} tone={tone ?? 'muted'} height={28} className="mt-2" />}
    </>
  );
  const cls = `block min-w-0 px-4 py-3.5 text-left ${className}`;
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${cls} rounded-xl transition-colors duration-fast hover:bg-stone-50 ${active ? 'bg-stone-50' : ''}`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
