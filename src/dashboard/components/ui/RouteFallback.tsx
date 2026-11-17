import type { ReactNode } from 'react';

/**
 * What shows while a page chunk loads or the session check runs: the page's own outline in neutral tokens, so
 * the screen holds its shape and the content replaces it in place. The header matches the static shell in
 * index.html, which paints before any script runs; keep the two in step.
 */
export type FallbackKind = 'home' | 'site' | 'settings' | 'list' | 'section' | 'plain' | 'login';

const bar = 'rounded-lg bg-stone-100 motion-safe:animate-pulse';
const card = 'rounded-2xl border border-stone-200/80 bg-white';

const MARK = (
  <svg width="28" height="28" viewBox="0 0 1024 1024" aria-hidden="true">
    <rect width="1024" height="1024" rx="230" fill="#0f1730" />
    <path
      d="M170 774C196.7 749 283.3 637.3 330 624C376.7 610.7 405 720.7 450 694C495 667.3 558.3 495.7 600 464C641.7 432.3 658.3 544 700 504C741.7 464 825 270.7 850 224"
      fill="none"
      stroke="#2ee6a6"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="64"
    />
    <circle cx="850" cy="224" r="46" fill="#2ee6a6" />
  </svg>
);

function Header() {
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {MARK}
        <span className="text-lg font-semibold tracking-tight">FounderData</span>
      </div>
      <div className="flex items-center gap-2" aria-hidden="true">
        <div className={`${bar} hidden h-9 w-24 sm:block`} />
        <div className={`${bar} h-9 w-9`} />
      </div>
    </header>
  );
}

const Tiles = ({ n, className = '' }: { n: number; className?: string }) => (
  <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${className}`}>
    {Array.from({ length: n }, (_, i) => (
      <div key={i} className={`${card} h-[92px] p-4`}>
        <div className={`${bar} h-3 w-16`} />
        <div className={`${bar} mt-3 h-6 w-24`} />
      </div>
    ))}
  </div>
);

const Block = ({ h = 'h-64' }: { h?: string }) => <div className={`${card} ${h} p-5`}><div className={`${bar} h-4 w-32`} /></div>;

function Body({ kind }: { kind: FallbackKind }): ReactNode {
  switch (kind) {
    case 'home':
      return (
        <>
          <div className="mt-6 sm:mt-8">
            <div className={`${bar} h-7 w-56`} />
            <div className={`${bar} mt-2 h-4 w-80 max-w-full`} />
          </div>
          <Tiles n={8} className="mt-6 lg:grid-cols-4" />
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Block />
            <Block />
          </div>
        </>
      );
    case 'site':
      return (
        <>
          <Tiles n={7} className="mt-4 lg:grid-cols-7" />
          <div className="mt-4"><Block h="h-[340px]" /></div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Block />
            <Block />
            <Block />
            <Block />
          </div>
        </>
      );
    case 'section':
      return (
        <div className="space-y-4">
          <Tiles n={4} />
          <Block h="h-[300px]" />
          <Block h="h-48" />
        </div>
      );
    case 'settings':
      return (
        <div className="mt-6 grid gap-6 lg:grid-cols-[200px_1fr]">
          <div className="hidden space-y-2 lg:block">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className={`${bar} h-6 w-32`} />)}
          </div>
          <div className="space-y-4">
            <Block h="h-56" />
            <Block h="h-40" />
            <Block h="h-40" />
          </div>
        </div>
      );
    case 'list':
      return (
        <div className="mt-6">
          <div className={`${bar} h-7 w-48`} />
          <div className={`${card} mt-5 divide-y divide-stone-100`}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 p-4">
                <div className={`${bar} h-5 w-5 rounded-full`} />
                <div className={`${bar} h-4 w-40`} />
                <div className={`${bar} ml-auto h-4 w-16`} />
              </div>
            ))}
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function RouteFallback({ kind = 'home' }: { kind?: FallbackKind }) {
  if (kind === 'login' || kind === 'plain') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4" role="status" aria-label="Loading">
        <div className={`${card} h-[300px] w-full max-w-sm p-8`}>
          <div className={`${bar} h-7 w-28`} />
          <div className={`${bar} mt-6 h-6 w-40`} />
          <div className={`${bar} mt-6 h-9 w-full`} />
        </div>
      </div>
    );
  }
  // A section sits inside the Dashboard, which already has its header and toolbar.
  if (kind === 'section') return <div role="status" aria-label="Loading"><Body kind={kind} /></div>;
  const wide = kind === 'site' ? 'max-w-[1240px] px-3 pb-10 pt-4 sm:px-6 sm:pt-6' : 'max-w-7xl px-4 py-5 sm:py-10';
  return (
    <div className={`mx-auto ${wide}`} role="status" aria-label="Loading">
      <Header />
      <Body kind={kind} />
    </div>
  );
}
