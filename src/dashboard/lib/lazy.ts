import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** A lazy component that can also be loaded ahead of time: `Page.preload()` on hover, focus or at idle. */
export type Preloadable<C extends ComponentType<any>> = LazyExoticComponent<C> & {
  preload: () => Promise<unknown>;
  /** The chunk has arrived, so rendering the component will not suspend. */
  loaded: () => boolean;
};

/**
 * `lazyNamed(() => import('./Home'), 'Home')`: React.lazy for a module with a named export. The import runs once;
 * a failed load is forgotten, so the next preload or render tries again.
 */
export function lazyNamed<M extends Record<string, any>, K extends keyof M & string>(load: () => Promise<M>, key: K): Preloadable<M[K]> {
  let pending: Promise<M> | null = null;
  let done = false;
  const once = () =>
    (pending ??= load().then(
      (m) => {
        done = true;
        return m;
      },
      (e) => {
        pending = null;
        throw e;
      },
    ));
  const Component = lazy(() => once().then((m) => ({ default: m[key] as M[K] }))) as Preloadable<M[K]>;
  Component.preload = () => once().catch(() => undefined);
  Component.loaded = () => done;
  return Component;
}
