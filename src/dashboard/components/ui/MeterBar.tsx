export type MeterTone = 'visitors' | 'revenue' | 'muted';
const FILL: Record<MeterTone, string> = { visitors: 'bg-visitors', revenue: 'bg-revenue', muted: 'bg-stone-400' };

/**
 * The thin share bar used in tables and breakdowns: 4 px tall, a stone track, a fill that grows by transform (never by
 * width). `share` is a fraction of the track, 0 to 1. Blue is visitors, coral is revenue, `muted` is neither.
 * Decorative by default; pass `label` ("34% of visitors") when the bar is the only place the share is written.
 */
export function MeterBar({ share, tone = 'visitors', label, className = '' }: { share: number; tone?: MeterTone; label?: string; className?: string }) {
  const s = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  return (
    <div
      className={`h-1 w-full overflow-hidden rounded-full bg-stone-100 ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div
        className={`h-full w-full rounded-full ${FILL[tone]} transition-transform duration-slower ease-out`}
        style={{ transform: `translateX(${((s - 1) * 100).toFixed(2)}%)` }}
      />
    </div>
  );
}
