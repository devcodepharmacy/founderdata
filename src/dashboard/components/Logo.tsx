import { useId } from 'react';

/** The trail of the FounderData app icon (pro/apps/ios/scripts/make-icon.swift in Pro on 1024 units, y down), shared with public/logo.svg. */
export const TRAIL_PATH =
  'M170 774C196.7 749 283.3 637.3 330 624C376.7 610.7 405 720.7 450 694C495 667.3 558.3 495.7 600 464C641.7 432.3 658.3 544 700 504C741.7 464 825 270.7 850 224';

/**
 * FounderData mark, the iOS app icon: a trail that fades in and rises to a point, on deep navy. `animated` draws the
 * trail from left to right and lands the point (about 700 ms in all, transform and opacity only), for the sign-in
 * screen and a first load. Reduced motion shows the finished mark.
 */
export function LogoMark({ size = 28, animated = false, className = '' }: { size?: number; animated?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const wipe = animated ? { transformBox: 'view-box' as const, transformOrigin: '170px 0', animation: 'fd-wipe 560ms var(--ease-out) 80ms both' } : undefined;
  const dot = (delay: number) =>
    animated ? { transformBox: 'fill-box' as const, transformOrigin: 'center', animation: `fd-dot-in 360ms var(--ease-spring) ${delay}ms both` } : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#16203f" />
          <stop offset="1" stopColor="#0a1022" />
        </linearGradient>
        <linearGradient id={`${id}t`} gradientUnits="userSpaceOnUse" x1="170" y1="774" x2="850" y2="224">
          <stop offset="0" stopColor="#2ee6a6" stopOpacity="0.08" />
          <stop offset="0.85" stopColor="#2ee6a6" />
        </linearGradient>
        {animated && (
          <clipPath id={`${id}c`}>
            <rect x="0" y="0" width="1024" height="1024" style={wipe} />
          </clipPath>
        )}
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${id}b)`} />
      <g clipPath={animated ? `url(#${id}c)` : undefined}>
        <path d={TRAIL_PATH} fill="none" stroke={`url(#${id}t)`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="120" opacity="0.16" />
        <path d={TRAIL_PATH} fill="none" stroke={`url(#${id}t)`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="64" />
      </g>
      <circle cx="850" cy="224" r="78" fill="#2ee6a6" fillOpacity="0.22" style={dot(560)} />
      <circle cx="850" cy="224" r="46" fill="#2ee6a6" style={dot(500)} />
    </svg>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <LogoMark size={small ? 24 : 28} />
      <span className={`font-semibold tracking-tight ${small ? 'text-base' : 'text-lg'}`}>FounderData</span>
    </div>
  );
}

/**
 * The logo as the way home: every screen's header starts with it, and a click opens the home page with all websites
 * and apps. In the crowded site toolbar the word mark hides on narrow screens.
 */
export function HomeLink({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="/"
      onClick={(e) => {
        // Plain clicks stay in the app; cmd-click and middle-click open a new tab as usual.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        window.history.pushState(null, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
      className={`group/home flex shrink-0 items-center gap-2 rounded-xl ${compact ? 'h-9 pr-1' : ''}`}
      aria-label="FounderData home: all websites and apps"
      title="All websites and apps"
    >
      <LogoMark size={compact ? 26 : 28} className="shadow-[0_0_0_1px_rgb(255_255_255/0.06)] rounded-[22%] transition-transform duration-base ease-spring group-hover/home:scale-105" />
      <span className={`font-semibold tracking-tight ${compact ? 'hidden text-[15px] lg:inline' : 'text-[17px]'}`}>FounderData</span>
    </a>
  );
}
