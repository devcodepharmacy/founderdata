import type { ReactNode } from 'react';

/**
 * A "not connected yet" state inside a card, in one row about 64 px tall: an icon, one title line, one muted line and
 * one action. Setup detail lives in Settings; the action links there. On a phone the action drops under the text.
 * For a whole empty section use `EmptyState`.
 */
export function SetupRow({ icon, title, children, action, className = '' }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`card-inset flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${className}`}>
      {icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-stone-200/80 bg-white text-stone-400" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-sm font-medium text-ink sm:truncate">{title}</div>
        {children && <div className="text-[13px] text-stone-500 sm:truncate">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
