import type { ReactNode } from 'react';
import { LiveDot } from './LiveDot';

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'live';

const TONE: Record<StatusTone, { chip: string; dot: string }> = {
  ok: { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60', dot: 'bg-emerald-500' },
  warn: { chip: 'bg-amber-50 text-amber-800 ring-amber-200/60', dot: 'bg-amber-500' },
  error: { chip: 'bg-red-50 text-red-700 ring-red-200/60', dot: 'bg-red-500' },
  info: { chip: 'bg-sky-50 text-sky-700 ring-sky-200/60', dot: 'bg-sky-700' },
  neutral: { chip: 'bg-stone-100 text-stone-600 ring-stone-200', dot: 'bg-stone-400' },
  live: { chip: 'bg-brand-soft text-brand-text ring-brand/20', dot: '' },
};

/**
 * A state in a word or two: Connected, Needs setup, Failed, Live. The tone carries the meaning, the text says it, so
 * it reads without color too. `live` pulses in the brand mint; keep it for things that update in real time.
 */
export function StatusChip({ tone = 'neutral', dot = true, children, className = '', title }: { tone?: StatusTone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium ring-1 ring-inset ${t.chip} ${className}`} title={title}>
      {dot && (tone === 'live' ? <LiveDot size={6} /> : <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />)}
      {children}
    </span>
  );
}
