import { useRef, type ReactNode } from 'react';
import { useIndicator } from './motion';

/**
 * The `.seg` tray with a thumb that slides to the pressed button. Put any buttons inside that mark the chosen one with
 * aria-pressed="true"; a dropdown trigger counts too. The Toolbar's period control uses it this way.
 */
export function SegTrack({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useIndicator(box, thumb, '[aria-pressed="true"]', null);
  return (
    <div ref={box} className={`seg ${className}`} data-thumb="" role="group" aria-label={label}>
      <span ref={thumb} className="fd-thumb" aria-hidden="true" />
      {children}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** A choice of two to five options that switches a whole view: Web or App, Day or Week. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
  size = 'md',
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** What the choice is about, for screen readers ("Platform"). */
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <SegTrack label={label} className={`${size === 'sm' ? '!h-8 [&>button]:px-2 [&>button]:text-[12px]' : ''} ${className}`}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </SegTrack>
  );
}
