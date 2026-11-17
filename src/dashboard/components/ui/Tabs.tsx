import { useRef, type ReactNode } from 'react';
import { useIndicator } from './motion';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * The `.tabs` row with a chip that slides to the active tab. For tabs inside a card (Channel, Referrer, Campaign).
 * Arrow keys move between tabs. Wrap your own `.tab` buttons with TabRow when they are not a plain list.
 */
export function Tabs<T extends string>({ items, value, onChange, label, className = '' }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = items[(i + d + items.length) % items.length];
    onChange(next.value);
    (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[(i + d + items.length) % items.length])?.focus();
  };
  return (
    <TabRow label={label} className={className} activeKey={value}>
      {items.map((t, i) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className={`tab whitespace-nowrap ${t.value === value ? 'tab-active' : ''}`}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </TabRow>
  );
}

/** A `.tabs` container whose `.tab-active` child gets the sliding chip. */
export function TabRow({ children, label, className = '', activeKey }: { children: ReactNode; label?: string; className?: string; activeKey?: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useIndicator(box, thumb, '.tab-active', activeKey);
  return (
    <div ref={box} role="tablist" aria-label={label} className={`tabs relative ${className}`} data-indicator="">
      <span ref={thumb} className="fd-thumb !rounded-lg" aria-hidden="true" />
      {children}
    </div>
  );
}
