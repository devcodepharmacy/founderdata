import { useEffect, useRef, useState } from 'react';
import { useThemePref, type ThemePref } from '../lib/theme';

const Sun = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />
  </svg>
);
const Screen = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Screen },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/**
 * A square header button that picks the theme: follow the system, or pin light or dark. `small` matches a plain `.btn`
 * (38 px); the default matches the 44 px site toolbar.
 */
export function ThemeToggle({ align = 'right', small = false }: { align?: 'left' | 'right'; small?: boolean }) {
  const [pref, setPref] = useThemePref();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Current = OPTIONS.find((o) => o.value === pref)!.icon;
  // Arrow keys move between the three choices, as in any menu.
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    items[(at + d + items.length) % items.length]?.focus();
  };
  return (
    <div className="relative flex" ref={ref}>
      <button
        className={`btn px-0 text-stone-600 hover:text-ink ${small ? 'h-8 w-8' : 'h-9 w-9'}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
      >
        {/* Keyed by the choice, so a new icon turns in instead of swapping. */}
        <span key={pref} className="flex" style={{ animation: 'fd-dot-in var(--dur-slow) var(--ease-out) both' }}>
          <Current />
        </span>
      </button>
      {open && (
        <div role="menu" aria-label="Theme" onKeyDown={onMenuKey} className={`pop pop-in absolute top-full z-40 mt-1.5 w-40 overflow-hidden p-1 ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'}`}>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="menuitemradio"
              aria-checked={pref === value}
              autoFocus={pref === value}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-fast hover:bg-stone-100 focus-visible:bg-stone-100 ${pref === value ? 'font-medium text-ink' : 'text-stone-600'}`}
              onClick={() => {
                setPref(value);
                setOpen(false);
              }}
            >
              <span className={pref === value ? 'text-ink' : 'text-stone-400'}>
                <Icon />
              </span>
              {label}
              {pref === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The mark on the chosen item of a menu. */
export const Check = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0 text-stone-500" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
