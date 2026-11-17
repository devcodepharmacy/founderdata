import { useState, type ReactNode } from 'react';
import { useDash } from '../../lib/context';
import { changeView } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { InfoTip } from '../InfoTip';
import { EmptyIcons, EmptyState } from '../ui/EmptyState';
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
 * The change against the period before as a chip, with the same text changeView gives everywhere else: "32%", or the
 * absolute change from a zero, or "no data before". Green is good; `invert` where lower is better.
 */
export function Delta({ cur, prev, invert = false, noData = false, fmt, before = 'before', size = 'sm' }: { cur: number; prev: number; invert?: boolean; noData?: boolean; fmt: (n: number) => string; before?: string; size?: 'xs' | 'sm' }) {
  const v = changeView(cur, prev, { noData, fmt });
  if (v.kind === 'noData') return <span className="text-xs text-stone-400">{v.text}</span>;
  const box = `inline-flex shrink-0 items-center gap-0.5 rounded-md font-medium tabular-nums ${size === 'xs' ? 'h-[18px] px-1 text-[11px]' : 'h-5 px-1.5 text-xs'}`;
  if (v.kind === 'none') return <span className={`${box} bg-stone-100 text-stone-500`} title={`${fmt(prev)} ${before}`}>0%</span>;
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
 * A dashboard card. `info` is the card's fine print, behind an (i) next to the title. `note` is the older footnote
 * under the card, kept for the tabs that still use it.
 */
export function Card({ title, right, children, note, info, infoLabel, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; note?: ReactNode; info?: ReactNode; infoLabel?: string; className?: string }) {
  return (
    <section className={`card flex min-w-0 flex-col p-3 ${className}`}>
      <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {typeof title === 'string' ? (
            <h3 className="px-2 text-[13px] font-semibold text-ink">{title}</h3>
          ) : (
            <div className="tabs">{title}</div>
          )}
          {info && <InfoTip label={infoLabel ?? (typeof title === 'string' ? `How ${title} is counted` : 'How this card is counted')}>{info}</InfoTip>}
        </div>
        {right}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto">{children}</div>
      {note && <p className="px-3 pt-3 text-xs text-stone-500">{note}</p>}
    </section>
  );
}

/** A table whose first column is the label and the rest right-aligned numbers. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-stone-400">
            {head.map((h, i) => (
              <th key={i} className={`h-8 whitespace-nowrap font-medium ${i ? 'pl-3 pr-2 text-right' : 'pl-2'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A table row: 40 px, a hover wash, and Enter to click when it filters. */
export function Row({ cells, onClick, title }: { cells: ReactNode[]; onClick?: () => void; title?: string }) {
  return (
    <tr
      className={`border-t border-stone-200/60 transition-colors duration-fast ${onClick ? 'cursor-pointer hover:bg-stone-50 focus-visible:bg-stone-50' : ''}`}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
      title={title ?? (onClick ? 'Click to filter' : undefined)}
    >
      {cells.map((c, i) => (
        <td key={i} className={`h-10 py-1.5 ${i ? 'pl-3 pr-2 text-right tabular-nums' : 'max-w-[280px] truncate pl-2'}`}>
          {c}
        </td>
      ))}
    </tr>
  );
}

export const SmallSample = () => (
  <span className="ml-2 inline-flex h-[18px] items-center rounded-md bg-amber-50 px-1.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200/60" title="Fewer than 100 sessions. Compare the counts, not the rates.">
    small sample
  </span>
);

/** A share as a thin bar that grows by transform. */
export function Bar({ share, tone = 'visitors' }: { share: number; tone?: 'visitors' | 'revenue' | 'muted' }) {
  const fill = tone === 'revenue' ? 'bg-revenue' : tone === 'muted' ? 'bg-stone-400' : 'bg-visitors';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
      <div className={`h-full w-full rounded-full ${fill} transition-transform duration-slower ease-out`} style={{ transform: `translateX(${((Math.max(0, Math.min(1, share)) - 1) * 100).toFixed(2)}%)` }} />
    </div>
  );
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
  return { background: `rgb(var(--visitors) / ${(0.06 + a * 0.84).toFixed(2)})`, text: a >= 0.5 ? 'text-onFill' : 'text-ink' };
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
