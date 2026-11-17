import type { ReactNode } from 'react';
import { LogoMark, TRAIL_PATH } from '../Logo';
import { ThemeToggle } from '../ThemeToggle';

/**
 * The frame of the screens before sign-in (Login, Join): the drawn logo, a card, and a quiet backdrop. The backdrop is
 * a static grid and the logo's trail, with one soft glow drifting on a 24 s loop; it moves by transform only and stops
 * under reduced motion.
 */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-12">
      <Backdrop />
      <div className="absolute right-4 top-4">
        <ThemeToggle small />
      </div>
      <div className="relative w-full max-w-[380px] normal-nums">
        <div className="mb-7 flex flex-col items-center">
          <div className="relative">
            <div className="absolute -inset-6 rounded-full bg-brand/20 blur-2xl dark:bg-brand/15" style={{ animation: 'fd-fade 900ms var(--ease-out) 300ms both' }} aria-hidden="true" />
            <LogoMark size={52} animated className="relative rounded-[12px] shadow-[0_8px_24px_-6px_rgb(10_16_34/0.5),0_0_0_1px_rgb(255_255_255/0.08)]" />
          </div>
        </div>
        <div className="card fd-reveal p-7 shadow-overlay sm:p-8" style={{ ['--fd-delay' as string]: '120ms' }}>
          {children}
        </div>
        {footer && (
          <div className="fd-reveal mt-6 text-center text-xs text-stone-400" style={{ ['--fd-delay' as string]: '220ms' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-0" aria-hidden="true">
      {/* A fine grid that fades out toward the edges. */}
      <div
        className="absolute inset-0 opacity-[0.5] dark:opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgb(var(--stone-200)) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--stone-200)) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          backgroundPosition: 'center center',
          maskImage: 'radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 75%)',
        }}
      />
      {/* One drifting glow in the brand navy and mint. */}
      <div
        className="absolute left-1/2 top-[38%] h-[640px] w-[900px] -translate-x-1/2 -translate-y-1/2"
        style={{ animation: 'fd-drift 24s var(--ease-in-out) infinite alternate' }}
      >
        <div
          className="h-full w-full opacity-70 dark:opacity-100"
          style={{ background: 'radial-gradient(closest-side, rgb(var(--brand) / 0.10), transparent), radial-gradient(closest-side at 30% 60%, rgb(46 74 140 / 0.14), transparent)' }}
        />
      </div>
      {/* The logo's trail, large and faint, rising across the lower half. */}
      <svg className="absolute -bottom-24 left-1/2 w-[1200px] max-w-none -translate-x-1/2 opacity-[0.06] dark:opacity-[0.05]" viewBox="120 180 800 640" fill="none">
        <path d={TRAIL_PATH} stroke="rgb(var(--brand-text))" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** An error under a form: an icon and the server's message, announced to screen readers. It shakes once on arrival. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="mt-3 flex animate-shake items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 ring-1 ring-inset ring-red-200/60">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mt-px shrink-0" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5v.01" />
      </svg>
      <span>{children}</span>
    </div>
  );
}
