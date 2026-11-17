import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over a blurred page. It springs in (320 ms), keeps Tab inside itself, closes on Escape or a click outside,
 * and gives focus back to whatever opened it. A field with autoFocus inside keeps its focus; otherwise the dialog
 * itself takes it, so the first Tab lands on the first control.
 */
export function Modal({
  open,
  onClose,
  children,
  width = 'max-w-2xl',
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  title?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  // What had focus before the dialog opened, read during render: by the time effects run, an autoFocus field inside
  // has taken it.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const back = opener.current;
    const box = panel.current;
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // Hold the page still without the scrollbar's width making it jump sideways.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap) document.body.style.paddingRight = `${gap}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/25 p-4 backdrop-blur-[6px] dark:bg-black/60 sm:p-10"
      style={{ animation: 'fd-fade var(--dur-base) var(--ease-out) both' }}
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`card w-full ${width} p-0 shadow-overlay outline-none sm:mt-[4vh]`}
        style={{ animation: 'fd-dialog-in var(--dur-slower) var(--ease-spring) both' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between gap-4 border-b border-stone-200/70 px-6 py-4">
            <div id={titleId} className="text-title">
              {title}
            </div>
            <button
              className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink"
              onClick={onClose}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
