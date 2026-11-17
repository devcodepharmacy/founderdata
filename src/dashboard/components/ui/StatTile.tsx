import { Children, createContext, useContext, type ReactNode } from 'react';
import { ChangeBadge, NoComparison } from './ChangeBadge';
import { NumberTicker } from './NumberTicker';
import { Skeleton } from './Skeleton';
import { Sparkline, type SeriesTone } from './Sparkline';

/** True inside a StatStrip: the tile then pads for the strip and stretches to its row's height. */
const InStrip = createContext(false);

const TONE_VAR: Record<SeriesTone, string> = { visitors: '--visitors', revenue: '--revenue', brand: '--brand-text', muted: '--stone-400' };

/**
 * One headline number: a label, the value (counting to each new value), a meta line under it and an optional
 * sparkline. It has no border of its own: use it in a `StatStrip`, or inside a card.
 *
 * - The value and its `unit` share one baseline row with a gap, and so do the change badge, `sub` and `footer`, so
 *   nothing ever touches.
 * - `value` null shows a muted dash ("not measured"), never a 0. `display` replaces the ticking number with your own
 *   node (a word, a "3 of 5"), keeping the layout.
 * - `change` is a fraction against the period before. `undefined` means there is no comparison here and shows
 *   nothing. `null` means there is one but the period before had no data: a muted dash with a title.
 * - `sub` is one short muted line next to the change; `footer` is the same slot for a node of your own (a link, a chip).
 * - `spark` sits at the bottom of the tile, so tiles of one strip line their lines up even when only some have one.
 * - While `loading` with no value yet, skeletons hold the same height.
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
  sub,
  unit,
  display,
  sparkHeight = 28,
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
  /** One short muted line after the change: "against 599 before", "2 customers". */
  sub?: ReactNode;
  /** A muted unit after the value, on its baseline: "clicks", "/ day". */
  unit?: ReactNode;
  /** Shown in place of the ticking number when the value is not a plain number. */
  display?: ReactNode;
  sparkHeight?: number;
}) {
  const inStrip = useContext(InStrip);
  const swatch = tone === 'visitors' ? 'bg-visitors' : tone === 'revenue' ? 'bg-revenue' : tone === 'brand' ? 'bg-brand' : null;
  const none = value === null || value === undefined;
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-stone-500">
        {swatch && <span className={`h-2 w-2 shrink-0 rounded-[3px] ${swatch}`} aria-hidden="true" />}
        <span className="truncate">{label}</span>
        {info}
      </div>
      {loading && none && display === undefined ? (
        <>
          <Skeleton className="mt-2 h-7 w-24" />
          <Skeleton className="mt-2 h-4 w-12" />
        </>
      ) : (
        <>
          <div className={`mt-1 flex min-w-0 items-baseline gap-2 transition-opacity duration-base ${loading ? 'opacity-60' : ''}`}>
            <span className="min-w-0 truncate text-stat text-ink">
              {display !== undefined ? display : none ? <span className="text-stone-300" title="Not measured">–</span> : <NumberTicker value={value} format={format} />}
            </span>
            {unit && <span className="shrink-0 text-[13px] text-stone-400">{unit}</span>}
          </div>
          <div className="mt-1 flex min-h-5 min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {change === null && !sub && !footer ? none ? null : <NoComparison /> : <ChangeBadge change={change} invert={invertChange} />}
            {sub && <span className="min-w-0 text-xs text-stone-400">{sub}</span>}
            {footer}
          </div>
        </>
      )}
      {spark && (
        <div className="mt-auto pt-3">
          <Sparkline values={spark} tone={tone ?? 'muted'} height={sparkHeight} />
        </div>
      )}
    </>
  );
  const cls = `flex h-full min-w-0 flex-col text-left ${inStrip ? 'px-5 py-4' : 'px-4 py-3.5'} ${className}`;
  if (!onClick) return <div className={cls}>{body}</div>;
  const mark = active ? `inset 0 -2px 0 rgb(var(${TONE_VAR[tone ?? 'muted']}))` : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={mark ? { boxShadow: mark } : undefined}
      className={`${cls} w-full transition-colors duration-fast hover:bg-stone-50 focus-visible:-outline-offset-2 ${inStrip ? '' : 'rounded-xl'} ${active ? 'bg-stone-50' : ''}`}
    >
      {body}
    </button>
  );
}

/**
 * Stat tiles in one card, one row from lg up with a hairline between tiles, two columns on phones and tablets (an odd
 * last tile spans both), every tile as tall as the tallest. Children are `StatTile`s, direct children.
 *
 * `columns` sets the tiles per row from lg up (default: all of them up to 6, else half, rounded up). `flat` drops the
 * card, for a strip inside a card that goes on below it (a chart); the strip then keeps a hairline under itself.
 * `label` names the group for screen readers.
 */
export function StatStrip({ children, columns, flat = false, label, className = '' }: { children: ReactNode; columns?: number; flat?: boolean; label?: string; className?: string }) {
  const items = Children.toArray(children);
  const n = items.length;
  const cols = columns ?? (n <= 6 ? Math.max(1, n) : Math.ceil(n / 2));
  return (
    <div className={`overflow-hidden ${flat ? '' : 'card'} ${className}`}>
      <div role={label ? 'group' : undefined} aria-label={label} data-flat={flat || undefined} className="stat-strip" style={{ ['--cols' as string]: cols }}>
        <InStrip.Provider value>{items}</InStrip.Provider>
      </div>
    </div>
  );
}
