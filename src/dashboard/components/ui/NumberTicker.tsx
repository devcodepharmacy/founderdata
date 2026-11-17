import { useEffect, useRef, useState } from 'react';
import { DUR, prefersReducedMotion } from './motion';

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * A number that counts from its last value to the new one in 320 ms. The first paint shows the value as it is, and so
 * does reduced motion. Its width is the wider of the old and new text from the start, so nothing beside it moves.
 * `format` turns the number into text (money, percent, compact); pass a stable function or a module-level one.
 */
export function NumberTicker({
  value,
  format = (n) => Math.round(n).toLocaleString('en'),
  className = '',
  align = 'start',
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  align?: 'start' | 'end';
}) {
  const shown = useRef<HTMLSpanElement>(null);
  // The pair being shown: set during render when the value changes, so both widths hold until the next change.
  const [pair, setPair] = useState({ from: value, to: value, first: true });
  if (pair.to !== value) setPair({ from: pair.to, to: value, first: false });
  const fmt = useRef(format);
  fmt.current = format;

  useEffect(() => {
    const el = shown.current;
    if (!el) return;
    const { from, to, first } = pair;
    if (first || from === to || prefersReducedMotion() || document.hidden) {
      el.textContent = fmt.current(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DUR.slower);
      el.textContent = fmt.current(from + (to - from) * easeOut(t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = fmt.current(to);
    };
  }, [pair]);

  // Three texts in one grid cell: the old and new values hold the width, the visible one is drawn over them.
  return (
    <span className={`inline-grid tabular-nums ${className}`} style={{ justifyItems: align }}>
      <span aria-hidden="true" className="invisible [grid-area:1/1]">{format(pair.from)}</span>
      <span aria-hidden="true" className="invisible [grid-area:1/1]">{format(pair.to)}</span>
      <span ref={shown} className="[grid-area:1/1]" aria-live="off">
        {format(pair.first ? pair.to : pair.from)}
      </span>
    </span>
  );
}
