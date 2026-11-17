/**
 * A small dot that pulses while something is live. `brand` (mint) is for FounderData's own live moments, such as the
 * realtime view; `ok` (emerald) for a status. Off: a gray dot that does not move.
 */
export function LiveDot({ on = true, tone = 'brand', size = 8, label }: { on?: boolean; tone?: 'brand' | 'ok'; size?: number; label?: string }) {
  const color = !on ? 'bg-stone-300' : tone === 'brand' ? 'bg-brand' : 'bg-emerald-500';
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {on && <span className={`absolute inset-0 rounded-full ${color}`} style={{ animation: 'fd-ping 1.8s var(--ease-out) infinite' }} />}
      <span className={`relative inline-flex h-full w-full rounded-full ${color} ${on && tone === 'brand' ? 'shadow-[0_0_8px_rgb(var(--brand)/0.6)]' : ''}`} />
    </span>
  );
}
