import { createContext, useContext, useState, type ReactNode } from 'react';
import { useDash } from '../../lib/context';
import { changeView } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { InfoTip } from '../InfoTip';
import { NoComparison } from '../ui/ChangeBadge';
import { EmptyIcons, EmptyState } from '../ui/EmptyState';
import { MeterBar } from '../ui/MeterBar';
import { Skeleton } from '../ui/Skeleton';

/**
 * The site dashboard's building blocks: the card frame, its tables, the change chip, and the loading, empty and error
 * states every section shares. docs/DESIGN.md sets the look; these keep the sections from each inventing their own.
 */

/** useApi plus a retry: the inline error's button asks again without reloading the page. */
export function useSiteApi<T>(url: string | null, extraKey = 0) {
  const { reloadKey } = useDash();
  const [tries, setTries] = useState(0);
  const r = useApi<T>(url, reloadKey * 1000 + extraKey * 37 + tries);
  return { ...r, retry: () => setTries((t) => t + 1) };
}

/**
 * The change against the period before as a chip, with the same numbers changeView gives everywhere else: "32%", or the
 * absolute change from a zero. A missing comparison is quiet: in a table cell (`variant="cell"`, the default) it shows
 * nothing and keeps "no data before" for screen readers; in a stat tile (`variant="tile"`) it shows a muted dash with
 * a title. No change is a muted "0%". Green is good; `invert` where lower is better.
 */
export function Delta({ cur, prev, invert = false, noData = false, fmt, before = 'before', size = 'sm', variant = 'cell' }: { cur: number; prev: number; invert?: boolean; noData?: boolean; fmt: (n: number) => string; before?: string; size?: 'xs' | 'sm'; variant?: 'cell' | 'tile' }) {
  const v = changeView(cur, prev, { noData, fmt });
  if (v.kind === 'noData') return variant === 'tile' ? <NoComparison /> : <span className="sr-only">{v.text}</span>;
  const box = `inline-flex shrink-0 items-center gap-0.5 rounded-md font-medium tabular-nums ${size === 'xs' ? 'h-[18px] px-1 text-[11px]' : 'h-5 px-1.5 text-xs'}`;
  if (v.kind === 'none') {
    return (
      <span className={`inline-flex shrink-0 items-center font-medium tabular-nums text-stone-400 ${size === 'xs' ? 'h-[18px] text-[11px]' : 'h-5 text-xs'}`} title={`${fmt(prev)} ${before}`}>
        <span className="sr-only">{v.text}</span>
        <span aria-hidden="true">0%</span>
      </span>
    );
  }
  const good = invert ? !v.up : v.up;
  const text = v.text.replace(/\s*[↑↓]$/, '');
  return (
    <span className={`${box} ${good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`} title={`${fmt(prev)} ${before}`}>
      <Arrow up={!!v.up} />
      <span className="sr-only">{v.up ? 'Up' : 'Down'} </span>
      {text}
    </span>
  );
}

export function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" className={up ? '' : 'rotate-180'}>
      <path d="M6 9.5V2.5M2.75 5.75 6 2.5l3.25 3.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A dashboard card. `info` is the card's fine print, behind an (i) next to the title; `sub` is one muted line under
 * it. `note` is the older footnote under the card, kept for the tabs that still use it. The header lines up with
 * ui/CardHeader: the title sits 20 px from the left and 28 px from the top, the body starts at 52 px.
 */
export function Card({ title, right, children, note, info, infoLabel, sub, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; note?: ReactNode; info?: ReactNode; infoLabel?: string; sub?: ReactNode; className?: string }) {
  return (
    <section className={`card flex min-w-0 flex-col p-3 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 pb-2">
        <div className="min-w-0">
          <div className="flex min-h-8 min-w-0 items-center gap-1.5">
            {typeof title === 'string' ? <h3 className="truncate px-2 text-[13px] font-semibold text-ink">{title}</h3> : <div className="tabs">{title}</div>}
            {info && <InfoTip label={infoLabel ?? (typeof title === 'string' ? `How ${title} is counted` : 'How this card is counted')}>{info}</InfoTip>}
          </div>
          {sub && <div className="-mt-1 px-2 pb-1 text-[13px] text-stone-500">{sub}</div>}
        </div>
        {right && <div className="-my-0.5 flex min-h-8 items-center gap-2">{right}</div>}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto">{children}</div>
      {note && <p className="px-3 pt-3 text-xs text-stone-500">{note}</p>}
    </section>
  );
}

/** Column alignment a Table hands to its Rows. */
type Align = 'left' | 'right';
const AlignContext = createContext<Align[] | null>(null);
const alignOf = (align: Align[] | null, i: number): Align => align?.[i] ?? (i ? 'right' : 'left');

/**
 * A table whose first column is the label and the rest right-aligned numbers (`align` overrides a column). The header
 * is 12 px medium stone-400 and 36 px tall, rows are 40 px with a hairline between them. `head` entries are nodes:
 * a plain string is enough.
 */
export function Table({ head, children, align }: { head: ReactNode[]; children: ReactNode; align?: Align[] }) {
  return (
    <AlignContext.Provider value={align ?? null}>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-stone-400">
              {head.map((h, i) => (
                <th key={i} className={`h-9 whitespace-nowrap font-medium ${alignOf(align ?? null, i) === 'right' ? 'pl-3 pr-2 text-right' : i ? 'px-3' : 'pl-2'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </AlignContext.Provider>
  );
}

/** A table cell with nothing to show: a stone dash with a title. `Row` uses it for null, undefined and "" cells. */
export function NoValue({ title = 'No value' }: { title?: string }) {
  return (
    <span className="text-stone-300" title={title}>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** A count in a table cell: ink when there is something, stone-400 for zero, a dash for null. */
export function Num({ value, format = (n: number) => n.toLocaleString('en'), title }: { value: number | null | undefined; format?: (n: number) => string; title?: string }) {
  if (value === null || value === undefined) return <NoValue title={title} />;
  return <span className={value === 0 ? 'text-stone-400' : undefined}>{format(value)}</span>;
}

/**
 * A table row: 40 px, a hairline above, a hover wash, and Enter to click when it filters. A cell that is the number 0
 * or "0" is muted to stone-400, and a cell that is null, undefined or "" shows a stone dash; `false` renders nothing,
 * so `cond && <X />` still works. Alignment follows the Table's `align`.
 */
export function Row({ cells, onClick, title, className = '' }: { cells: ReactNode[]; onClick?: () => void; title?: string; className?: string }) {
  const align = useContext(AlignContext);
  return (
    <tr
      className={`border-t border-stone-200/60 transition-colors duration-fast hover:bg-stone-50 ${onClick ? 'cursor-pointer focus-visible:bg-stone-50' : ''} ${className}`}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
      title={title ?? (onClick ? 'Click to filter' : undefined)}
    >
      {cells.map((c, i) => {
        const empty = c === null || c === undefined || c === '';
        const zero = c === 0 || c === '0';
        return (
          <td key={i} className={`h-10 py-1.5 ${alignOf(align, i) === 'right' ? 'pl-3 pr-2 text-right tabular-nums' : i ? 'px-3' : 'max-w-[280px] truncate pl-2'} ${zero ? 'text-stone-400' : ''}`}>
            {empty ? <NoValue /> : c}
          </td>
        );
      })}
    </tr>
  );
}

export const SmallSample = () => (
  <span className="ml-2 inline-flex h-[18px] items-center rounded-md bg-amber-50 px-1.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200/60" title="Fewer than 100 sessions. Compare the counts, not the rates.">
    small sample
  </span>
);

/** A share as a thin bar that grows by transform. The same bar as ui/MeterBar, kept under its old name. */
export function Bar({ share, tone = 'visitors' }: { share: number; tone?: 'visitors' | 'revenue' | 'muted' }) {
  return <MeterBar share={share} tone={tone} />;
}

/** A table's shape while it loads: a header line and rows of the real row height. */
export function SkeletonTable({ rows = 5, cols = 4, className = '' }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={className} role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex h-8 items-center gap-6 px-2">
        <Skeleton className="h-3 w-20" />
        <span className="flex-1" />
        {Array.from({ length: cols - 1 }, (_, i) => (
          <Skeleton key={i} className="h-3 w-12" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-10 items-center gap-6 border-t border-stone-200/60 px-2">
          <Skeleton className="h-3.5" style={{ width: `${34 - ((r * 7) % 16)}%` }} />
          <span className="flex-1" />
          {Array.from({ length: cols - 1 }, (_, i) => (
            <Skeleton key={i} className="h-3.5 w-12" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The server's message next to the card it broke, and a button to ask again. */
export function ErrorLine({ error, retry, className = '' }: { error: string; retry?: () => void; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-red-200/60 bg-red-50 px-3 py-2.5 text-[13px] text-red-700 ${className}`} role="alert">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </svg>
      <span className="min-w-0 flex-1">{error}</span>
      {retry && (
        <button className="rounded-md px-2 py-0.5 text-xs font-medium text-red-700 underline-offset-2 hover:bg-red-100 hover:underline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Loading, error and empty for a card's body. With old data on screen and new data loading, the old data stays and
 * dims, so a period change never blanks the card.
 */
export function State({
  loading,
  error,
  empty,
  retry,
  skeleton,
  emptyTitle = 'No app data for this period',
  emptyBody,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  retry?: () => void;
  skeleton?: ReactNode;
  emptyTitle?: ReactNode;
  emptyBody?: ReactNode;
  children: ReactNode;
}) {
  if (error && empty) return <ErrorLine error={error} retry={retry} />;
  if (loading && empty) return <>{skeleton ?? <SkeletonTable />}</>;
  if (empty) return <EmptyState compact icon={EmptyIcons.chart} title={emptyTitle}>{emptyBody}</EmptyState>;
  return (
    <div className={`transition-opacity duration-base ${loading ? 'opacity-60' : ''}`}>
      {error && <ErrorLine error={error} retry={retry} className="mb-3" />}
      {children}
    </div>
  );
}

/** A series swatch and its name, for a chart's key. */
export function Key({ swatch, label }: { swatch: string; label: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={swatch} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Small target glyph for goals, in place of an emoji. */
export function GoalIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={`shrink-0 ${className}`}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </svg>
  );
}

/**
 * One heatmap cell's look: the visitors blue at an opacity that follows `v / max`. The darker half takes on-fill text,
 * because white on this blue is 3:1 at best in the light theme.
 * Both retention grids use it, so a shade means the same on every screen.
 */
export function heat(v: number | null, max = 1): { background?: string; text: string } {
  if (v === null) return { text: 'text-stone-400' };
  const a = Math.min(1, Math.max(0, v / max));
  // The fill stops at 70 %, where ink keeps 4.9:1 on it in dark and 7:1 in light. Dark text on a fuller fill fell under 3.5:1 in dark.
  return { background: `rgb(var(--visitors) / ${(0.06 + a * 0.64).toFixed(2)})`, text: 'text-ink' };
}

/** The scale under a heatmap, so a shade reads as a number. */
export function HeatScale({ max = 1, className = '' }: { max?: number; className?: string }) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className={`flex items-center gap-2 text-[11px] tabular-nums text-stone-400 ${className}`} aria-hidden="true">
      <span>0%</span>
      <span className="flex h-2 w-32 overflow-hidden rounded-full">
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
          <span key={v} className="flex-1" style={{ background: heat(v).background }} />
        ))}
      </span>
      <span>{max >= 1 ? '100%' : `${pct(max)} or more`}</span>
    </div>
  );
}
