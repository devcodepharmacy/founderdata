/**
 * The change against the period before, as a small arrow and percent. `change` is a fraction (0.32 is +32 %); null
 * shows nothing, Infinity shows "new". Green means good: pass `invert` where lower is better (bounce rate, refunds,
 * churn). Changes under `flat` (default 0.5 %) read as no change, in gray.
 */
export function ChangeBadge({
  change,
  invert = false,
  flat = 0.005,
  size = 'sm',
  className = '',
  title,
}: {
  change: number | null | undefined;
  invert?: boolean;
  flat?: number;
  size?: 'xs' | 'sm';
  className?: string;
  title?: string;
}) {
  if (change === null || change === undefined || Number.isNaN(change)) return null;
  const text = size === 'xs' ? 'text-[11px] h-[18px] px-1' : 'text-xs h-5 px-1.5';
  const base = `inline-flex shrink-0 items-center gap-0.5 rounded-md font-medium tabular-nums ${text} ${className}`;
  if (!Number.isFinite(change)) return <span className={`${base} bg-brand-soft text-brand-text`} title={title ?? 'Nothing in the period before'}>new</span>;
  const up = change > 0;
  const isFlat = Math.abs(change) < flat;
  const good = invert ? !up : up;
  const tone = isFlat ? 'bg-stone-100 text-stone-500' : good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700';
  const pct = `${Math.round(Math.abs(change) * 100).toLocaleString('en')}%`;
  const word = isFlat ? 'No change' : `${up ? 'Up' : 'Down'} ${pct}`;
  return (
    <span className={`${base} ${tone}`} title={title ?? `${word} against the period before`}>
      {!isFlat && (
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" className={up ? '' : 'rotate-180'}>
          <path d="M6 9.5V2.5M2.75 5.75 6 2.5l3.25 3.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="sr-only">{word}</span>
      <span aria-hidden="true">{isFlat ? '0%' : pct}</span>
    </span>
  );
}
