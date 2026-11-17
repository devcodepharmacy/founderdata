import type { CSSProperties } from 'react';

/**
 * A placeholder block with a shimmer, shown while data loads. Give it the size of what it stands in for, so the page
 * does not move when the data arrives. Screen readers hear one "Loading" per group (`label`), not every block.
 */
export function Skeleton({ className = 'h-4 w-24', style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`fd-skeleton block ${className}`} style={style} />;
}

/** A busy region: wraps skeletons with aria-busy and one spoken label. */
function Busy({ label = 'Loading', className = '', children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Lines of text; the last one is shorter, like a paragraph. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <Busy className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full'}`} />
      ))}
    </Busy>
  );
}

/** A stat tile's shape: label, number, change. Matches StatTile's height. */
export function SkeletonTile({ className = '' }: { className?: string }) {
  return (
    <Busy className={`px-4 py-3.5 ${className}`}>
      <Skeleton className="h-3.5 w-20" />
      <Skeleton className="mt-2.5 h-7 w-28" />
      <Skeleton className="mt-2 h-3.5 w-12" />
    </Busy>
  );
}

/** A chart's shape: quiet gridlines and a rising block of bars. Pass the chart's own height. */
export function SkeletonChart({ height = 240, className = '' }: { height?: number; className?: string }) {
  const bars = [38, 52, 44, 60, 48, 66, 58, 72, 54, 70, 62, 80, 68, 76];
  return (
    <Busy className={`relative ${className}`} label="Loading chart">
      <div className="flex items-end gap-[3%] px-1" style={{ height }}>
        {bars.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-[4px]" style={{ height: `${h}%`, opacity: 0.55 + (i / bars.length) * 0.45 }} />
        ))}
      </div>
    </Busy>
  );
}

/** Rows of a breakdown or a table: an icon, a label and a number on the right. */
export function SkeletonRows({ rows = 6, className = '' }: { rows?: number; className?: string }) {
  return (
    <Busy className={`space-y-0.5 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-2.5 px-2.5">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${68 - ((i * 11) % 40)}%` }} />
          <Skeleton className="ml-auto h-3.5 w-12" />
        </div>
      ))}
    </Busy>
  );
}
