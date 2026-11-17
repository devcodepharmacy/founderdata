import type { CSSProperties, ElementType, ReactNode } from 'react';

/**
 * A 6 px rise and fade the first time the element mounts (240 ms). Re-renders do not replay it. Use it for a page's
 * main blocks, not for rows that update. `delay` in ms staggers neighbours by hand.
 */
export function Reveal({ as: Tag = 'div', delay = 0, className = '', style, children }: { as?: ElementType; delay?: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <Tag className={`fd-reveal ${className}`} style={delay ? { ...style, ['--fd-delay' as string]: `${delay}ms` } : style}>
      {children}
    </Tag>
  );
}

/**
 * Reveals each direct child in turn, 35 ms apart (the first 11; later ones arrive together). No wrapper per child, so
 * it works on a grid or a flex row: the class `fd-stagger` on your own container does the same.
 */
export function Stagger({ as: Tag = 'div', className = '', children }: { as?: ElementType; className?: string; children: ReactNode }) {
  return <Tag className={`fd-stagger ${className}`}>{children}</Tag>;
}
