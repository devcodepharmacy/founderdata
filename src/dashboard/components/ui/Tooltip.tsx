import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A short label on hover (after 350 ms) or keyboard focus (at once), above the element by default and flipped when
 * there is no room. For a word or a line: what an icon button does, a full date, an exact number. Longer fine print
 * belongs in InfoTip. The child must be one element that takes a ref (a button, a span).
 */
export function Tooltip({ content, side = 'top', children, delay = 350 }: { content: ReactNode; side?: 'top' | 'bottom'; children: ReactElement; delay?: number }) {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);

  const show = (now: boolean) => {
    clearTimeout(timer.current);
    if (now) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const a = anchor.current?.getBoundingClientRect();
    const t = tip.current;
    if (!a || !t) return;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const below = side === 'bottom' ? a.bottom + 6 + h < window.innerHeight : a.top - 6 - h < 0;
    setPos({
      top: below ? a.bottom + 6 : a.top - 6 - h,
      left: Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8)),
      below,
    });
  }, [open, side]);

  const child = children as ReactElement<Record<string, unknown>>;
  const p = child.props as Record<string, ((e: unknown) => void) | undefined>;
  return (
    <>
      {cloneElement(child, {
        ref: (el: HTMLElement | null) => {
          anchor.current = el;
        },
        'aria-describedby': open ? id : undefined,
        onMouseEnter: (e: unknown) => (show(false), p.onMouseEnter?.(e)),
        onMouseLeave: (e: unknown) => (hide(), p.onMouseLeave?.(e)),
        onFocus: (e: unknown) => ((e as { currentTarget: HTMLElement }).currentTarget.matches(':focus-visible') && show(true), p.onFocus?.(e)),
        onBlur: (e: unknown) => (hide(), p.onBlur?.(e)),
        onMouseDown: (e: unknown) => (hide(), p.onMouseDown?.(e)),
      })}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[70] max-w-[260px] rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-medium leading-snug text-white shadow-pop dark:bg-stone-200 dark:text-ink"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              animation: pos ? 'fd-fade var(--dur-fast) var(--ease-out) both' : undefined,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
