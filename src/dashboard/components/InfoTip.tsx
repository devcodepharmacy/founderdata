import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The (i) glyph. */
export function InfoGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.3v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  );
}

const WIDTH = 320;
const GAP = 6;

/**
 * Fine print behind an (i) button next to a title. Hover or keyboard focus shows it, a click pins it open (so links
 * inside can be used), and Escape or a click elsewhere closes it. The panel renders in a portal with fixed position,
 * so a card or a scrolling table cannot clip it, and it flips above the button near the bottom of the screen.
 */
export function InfoTip({ label, children, size = 14, className = '' }: { label: string; children: ReactNode; size?: number; className?: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout>>();
  const open = hover || focus || pinned;

  const close = useCallback(() => {
    setHover(false);
    setFocus(false);
    setPinned(false);
  }, []);

  // Close on Escape and, once pinned, on a click outside the button and the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !panel.current?.contains(t)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  // Below the button, kept on screen; above it when there is no room below.
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const b = btn.current?.getBoundingClientRect();
      if (!b) return;
      const w = Math.min(WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(b.left - 12, window.innerWidth - w - 8));
      const h = panel.current?.offsetHeight ?? 0;
      const below = b.bottom + GAP;
      const top = below + h > window.innerHeight - 8 && b.top - GAP - h > 8 ? b.top - GAP - h : below;
      setPos({ top, left });
    };
    place();
    // A second pass once the panel has its height.
    const raf = requestAnimationFrame(place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const enter = () => {
    clearTimeout(leave.current);
    setHover(true);
  };
  const exit = () => {
    clearTimeout(leave.current);
    leave.current = setTimeout(() => setHover(false), 120);
  };
  useEffect(() => () => clearTimeout(leave.current), []);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`inline-flex shrink-0 items-center justify-center rounded-full p-0.5 align-middle text-stone-400 transition-colors duration-fast hover:text-stone-700 ${open ? 'text-stone-700' : ''} ${className}`}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={enter}
        onMouseLeave={exit}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && setFocus(true)}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
      >
        <InfoGlyph size={size} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="tooltip"
            onMouseEnter={enter}
            onMouseLeave={exit}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: Math.min(WIDTH, window.innerWidth - 16),
              animation: pos ? 'fd-pop-in var(--dur-base) var(--ease-out) both' : undefined,
            }}
            className="pop fixed z-[55] space-y-2 p-3.5 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-stone-600 [&_a]:font-medium [&_a]:text-ink [&_a]:underline [&_a]:decoration-stone-300 [&_a]:underline-offset-2 hover:[&_a]:decoration-ink"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A title with its fine print one hover away. */
export function TitleWithInfo({ children, info, label }: { children: ReactNode; info?: ReactNode; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      {info && <InfoTip label={label ?? `About ${typeof children === 'string' ? children.toLowerCase() : 'this card'}`}>{info}</InfoTip>}
    </span>
  );
}
