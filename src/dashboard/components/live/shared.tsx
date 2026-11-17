import { useEffect, useRef, useState } from 'react';
import { LiveDot as UiLiveDot, NumberTicker, prefersReducedMotion } from '../ui';
import { countryName, currencyDecimals, fmtMoney, fmtNumber } from '../../lib/format';
import type { LiveEvent, LiveSite, LiveVisitor } from './types';

/**
 * Pieces the live card and the live page share: labels, the ticking number, the pulsing dot, rows that animate in
 * and out, and the few keyframes Tailwind does not ship. The accent reads --brand with a green fallback, as an RGB
 * triple like the other color tokens in styles.css.
 */

export const ACCENT = 'rgb(var(--brand, 46 230 166))';
export const accentA = (a: number) => `rgb(var(--brand, 46 230 166) / ${a})`;

/** Keyframes and a few classes. Rendered once per live surface; identical copies are harmless. */
export const LIVE_CSS = `
@keyframes fd-live-in { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
@keyframes fd-live-out { from { opacity: 1 } to { opacity: 0; transform: translateX(8px) } }
@keyframes fd-live-flash { 0% { background: rgb(var(--revenue) / .16) } 100% { background: transparent } }
@keyframes fd-live-shimmer { 0% { opacity: .45 } 50% { opacity: .9 } 100% { opacity: .45 } }
@keyframes fd-live-pop { 0% { opacity: 0; transform: translate(-50%, -100%) translateY(6px) scale(.92) } 100% { opacity: 1; transform: translate(-50%, -100%) scale(1) } }
.fd-live-in { animation: fd-live-in .24s var(--ease-out, cubic-bezier(.22,1,.36,1)) both }
.fd-live-out { animation: fd-live-out .24s ease-in both; pointer-events: none }
.fd-live-flash { animation: fd-live-flash 2.4s ease-out both }
.fd-live-skel { animation: fd-live-shimmer 1.6s ease-in-out infinite }
.fd-live-pop { animation: fd-live-pop .35s cubic-bezier(.2,.8,.2,1) both }
@media (prefers-reduced-motion: reduce) {
  .fd-live-in, .fd-live-out, .fd-live-flash, .fd-live-skel, .fd-live-pop { animation: none !important }
}
`;

export function LiveStyles() {
  return <style>{LIVE_CSS}</style>;
}

/** The pulsing mint dot beside a live count (components/ui LiveDot). `quiet`: gray and still. */
export function LiveDot({ size = 8, quiet = false }: { size?: number; quiet?: boolean }) {
  return <UiLiveDot on={!quiet} size={size} />;
}

export { prefersReducedMotion };

/** A number that counts to its new value instead of jumping (components/ui NumberTicker). */
export function TickingNumber({ value, format = fmtNumber }: { value: number; format?: (n: number) => string }) {
  return <NumberTicker value={value} format={format} />;
}

/**
 * Keeps a removed item on screen for `exitMs` so it can fade out, in the place it had. Returns each item with
 * `leaving` set on the ones on their way out. New items enter with the .fd-live-in class on mount.
 */
export function usePresence<T>(items: T[], key: (t: T) => string, exitMs = 500): { item: T; key: string; leaving: boolean }[] {
  const prev = useRef<{ item: T; key: string; leaving: boolean; until?: number }[]>([]);
  const [, bump] = useState(0);
  const now = Date.now();
  const nextKeys = new Set(items.map(key));
  const out: { item: T; key: string; leaving: boolean; until?: number }[] = items.map((item) => ({ item, key: key(item), leaving: false }));
  // Put each departing item back at the index it had, as long as its exit lasts.
  prev.current.forEach((p, i) => {
    if (nextKeys.has(p.key)) return;
    const until = p.leaving ? p.until! : now + exitMs;
    if (until <= now) return;
    out.splice(Math.min(i, out.length), 0, { ...p, leaving: true, until });
  });
  prev.current = out;
  const pending = out.some((o) => o.leaving);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => bump((n) => n + 1), exitMs + 20);
    return () => clearTimeout(t);
  });
  return out;
}

/** Re-renders every `ms`, for "2 min ago" labels. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "Berlin, Germany", "Germany" without a city, "Unknown location" without either. */
export function placeLabel(p: { city?: string | null; country?: string | null }): string {
  const country = p.country ? countryName(p.country) : null;
  if (p.city && country) return `${p.city}, ${country}`;
  return p.city ?? country ?? 'Unknown location';
}

/** "from Google", or "direct" for a visit with no referrer. */
export function sourceLabel(source: string | null): string {
  if (!source || /^direct/i.test(source)) return 'direct';
  return `from ${source}`;
}

export function pageLabel(v: Pick<LiveVisitor, 'page' | 'platform'>): string {
  return v.page ?? (v.platform === 'app' ? 'In the app' : '/');
}

/** "Berlin, Germany · /pricing · from Google" */
export function visitorLine(v: LiveVisitor): string {
  return [placeLabel(v), pageLabel(v), sourceLabel(v.source)].join(' · ');
}

export function eventAmount(e: LiveEvent): string | null {
  if (e.amount == null || !e.currency) return null;
  return fmtMoney(e.amount, e.currency, currencyDecimals(e.currency));
}

/** What an event did, for a row: "Paid $19", "Started a trial", "Signed up", or the goal's label. */
export function eventVerb(e: LiveEvent): string {
  const amount = eventAmount(e);
  if (e.kind === 'payment') return amount ? `Paid ${amount}` : 'Paid';
  if (e.kind === 'trial') return 'Started a trial';
  if (e.kind === 'signup') return 'Signed up';
  return e.label ?? 'Reached a goal';
}

/** "12s", "4 min", "1 h": short ages for live rows. */
export function shortAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s < 5 ? 'now' : `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

export function siteName(sites: LiveSite[], id: string): string {
  return sites.find((s) => s.id === id)?.name ?? '';
}

/** Payments per currency, never added across currencies. */
export function paymentTotals(events: LiveEvent[]): { currency: string; amount: number }[] {
  const by = new Map<string, number>();
  for (const e of events) if (e.kind === 'payment' && e.amount != null && e.currency) by.set(e.currency, (by.get(e.currency) ?? 0) + e.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
}

/** The events of the last `minutes` before `now`: the ones the globe draws, so every glowing dot is recent. */
export function recentEvents(events: LiveEvent[], now: number, minutes: number): LiveEvent[] {
  return events.filter((e) => e.ts > now - minutes * 60_000);
}
