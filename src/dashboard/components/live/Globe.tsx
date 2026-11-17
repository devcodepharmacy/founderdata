import { lazy, Suspense } from 'react';
import type { GlobeProps } from './GlobeView';

export type { GlobeProps };

const GlobeView = lazy(() => import('./GlobeView'));

/**
 * The live globe. Its renderer and map data are a separate chunk, fetched the first time a globe mounts; until
 * then a faint disc holds the space so the layout does not move.
 */
export function LiveGlobe(props: GlobeProps) {
  return (
    <Suspense fallback={<GlobePlaceholder fill={props.fill} className={props.className} />}>
      <GlobeView {...props} />
    </Suspense>
  );
}

export function GlobePlaceholder({ fill = 0.8, className = '' }: { fill?: number; className?: string }) {
  return (
    <div className={`relative grid h-full w-full place-items-center ${className}`} aria-hidden>
      <div
        className="fd-live-skel aspect-square rounded-full"
        style={{ height: `${fill * 100}%`, maxWidth: `${fill * 100}%`, background: 'radial-gradient(circle at 35% 30%, rgb(var(--stone-100)), rgb(var(--stone-50)) 70%)', boxShadow: 'inset 0 0 0 1px rgb(var(--stone-200))' }}
      />
    </div>
  );
}
