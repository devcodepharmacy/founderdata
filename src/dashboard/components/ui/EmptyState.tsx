import type { ReactNode } from 'react';

/**
 * What a card or a page shows when there is nothing to show yet. Say what is missing and why in `title`, the one next
 * step in `children` or `action`. `compact` is for inside a card; the default is for a whole section.
 */
export function EmptyState({ icon, title, children, action, compact = false, className = '' }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'px-4 py-8' : 'px-6 py-14'} ${className}`}>
      {icon && (
        <div className={`mb-3 flex items-center justify-center rounded-xl border border-stone-200/80 bg-stone-50 text-stone-400 shadow-card ${compact ? 'h-9 w-9' : 'h-11 w-11'}`} aria-hidden="true">
          {icon}
        </div>
      )}
      <div className={`font-medium text-ink ${compact ? 'text-sm' : 'text-title'}`}>{title}</div>
      {children && <div className={`mt-1 max-w-sm text-stone-500 ${compact ? 'text-[13px]' : 'text-sm'}`}>{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Icons sized for EmptyState. */
export const EmptyIcons = {
  chart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19h16M7 15v-3M12 15V8M17 15v-5" />
    </svg>
  ),
  search: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4-4" />
    </svg>
  ),
  plug: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4" />
    </svg>
  ),
  inbox: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13h4l1.5 3h5L16 13h4M5.5 6h13L20 13v5H4v-5z" />
    </svg>
  ),
};
