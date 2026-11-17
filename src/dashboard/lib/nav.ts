import { flushSync } from 'react-dom';
import { preloadRoute, warmRoute } from './routes';

/**
 * Client-side navigation: load the target's chunks first, push the URL, cross-fade to the new page, and look after
 * the scroll position (a new page starts at the top, back and forward return to where you were).
 *
 * navigate() sends a `popstate` event, as before, so the hooks that read the URL (usePath, useQueryState, Home's
 * period) keep working unchanged.
 */

/** A chunk that is not here yet is waited for this long; after that the skeleton shows while it loads. */
const CHUNK_WAIT_MS = 150;

type Kind = 'push' | 'pop' | 'load';
let kind: Kind = 'load';
let current = typeof window === 'undefined' ? '/' : window.location.pathname;
let token = 0;

const STORE_KEY = 'fd-scroll';
let positions: Record<string, number> = {};
try {
  positions = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
} catch {
  // No sessionStorage (private mode, blocked): positions live for this page load only.
}

function persist() {
  positions[current] = window.scrollY;
  try {
    const keys = Object.keys(positions);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete positions[k];
    sessionStorage.setItem(STORE_KEY, JSON.stringify(positions));
  } catch {
    // Same as above.
  }
}

/** Call once at startup. The browser would restore scroll before the page has any height; this does it after render. */
export function installNavigation() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  // First among the popstate listeners, so it runs before the hooks that re-render on the new URL.
  window.addEventListener('popstate', (e) => {
    positions[current] = window.scrollY;
    current = window.location.pathname;
    kind = e.isTrusted ? 'pop' : 'push';
  });
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist());
}

let cancelRestore: (() => void) | null = null;

/** Scroll to `y` once the page is tall enough, for up to about a second, and stop if the person scrolls first. */
function restore(y: number): void {
  cancelRestore?.();
  if (y <= 0) {
    // Newer Chrome returns a promise from scrollTo; nothing here uses it.
    window.scrollTo(0, 0);
    return;
  }
  let frames = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const ev of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(ev, stop);
  };
  cancelRestore = stop;
  for (const ev of ['wheel', 'touchstart', 'keydown']) window.addEventListener(ev, stop, { passive: true });
  const tick = () => {
    if (stopped) return;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room >= y || ++frames > 60) {
      window.scrollTo(0, y);
      stop();
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
}

/** App.tsx calls this after a route change has rendered. A link with a #hash scrolls itself. */
export function afterRoute(): void {
  if (window.location.hash) return;
  if (kind === 'push') {
    restore(0);
    return;
  }
  const type = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
  // The first render after a reload or a return to the tab keeps the old position; a fresh visit starts at the top.
  if (kind === 'pop' || type === 'reload' || type === 'back_forward') restore(positions[window.location.pathname] ?? 0);
  kind = 'push';
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function commit(): void {
  const send = () => void window.dispatchEvent(new PopStateEvent('popstate'));
  const start = (document as any).startViewTransition?.bind(document);
  if (!start || reduced()) return send();
  // The callback runs after the browser has taken the old frame; flushSync makes the new page render inside it.
  start(() => flushSync(send));
}

/** Go to a path inside the app. Same signature as before; the pages import it from App.tsx, which re-exports it. */
export function navigate(to: string): void {
  const mine = ++token;
  const go = (): void => {
    // A later navigate() superseded this one while its chunk loaded.
    if (mine !== token) return;
    window.history.pushState(null, '', to);
    commit();
  };
  const { pathname: path, search } = new URL(to, window.location.href);
  // The page's first requests start now, beside its chunks, instead of after them.
  warmRoute(path, search);
  const ready = preloadRoute(path);
  // Always return nothing: callers use navigate as an effect body, and React calls whatever an effect returns on cleanup.
  if (!ready) return go();
  Promise.race([ready, new Promise((r) => setTimeout(r, CHUNK_WAIT_MS))]).then(go);
}
