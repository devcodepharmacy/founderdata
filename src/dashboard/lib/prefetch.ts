import { isViewer, qs, type Query } from './api';
import { peek, prefetch, whenQuiet } from './cache';
import { Pages, Palette } from './pages';
import { dataOf, matchRoute, warmRoute } from './routes';
import { readQuery } from './useQueryState';

/**
 * Preload what a link points to before the click:
 *
 * - Hover (after 60 ms, so sweeping the mouse across a table starts nothing), focus and touchstart on an
 *   `<a href="/site/...">` load the page's chunks and start its first requests.
 * - A button that navigates opts in with `data-prefetch="/site/demo?period=30d"` (see prefetchProps), because it has
 *   no href to read.
 * - After the first render the browser is idle: the likely next chunks load then, and Home warms its biggest site.
 */

/** Spread onto a button or row that calls navigate(to): `<button {...prefetchProps(to)} onClick={() => navigate(to)}>`. */
export const prefetchProps = (to: string) => ({ 'data-prefetch': to });

let queryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A period or filter control is hovered or focused: fetch the answer its click would ask for, so the numbers are
 * there when the click lands. `<button onMouseEnter={() => warmQuery({ period: '7d' })} onFocus={...}>`. Home gets its
 * one request, a site page its overview (the panels below follow on the click). Resting for 80 ms starts it; sweeping
 * across a row of buttons starts only the last.
 */
export function warmQuery(patch: Partial<Query>) {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    const q = { ...readQuery(), ...patch };
    if (patch.period && patch.period !== 'custom') {
      q.from = undefined;
      q.to = undefined;
    }
    const route = matchRoute(window.location.pathname);
    const urls = dataOf(route, `?${qs(q)}`);
    // On a site page dataOf lists /api/sites first, then the overview.
    for (const url of route.page === 'dashboard' ? urls.slice(1, 2) : urls) prefetch(url);
  }, 80);
}

function targetOf(e: Event): string | null {
  const el = (e.target as Element | null)?.closest?.('[data-prefetch], a[href]');
  if (!el) return null;
  const href = el.getAttribute('data-prefetch') ?? el.getAttribute('href');
  // Same-origin paths only; /api links are downloads, not pages.
  return href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/') ? href : null;
}

function warmHref(href: string, lead: boolean) {
  const u = new URL(href, window.location.href);
  warmRoute(u.pathname, u.search, lead);
}

/** A slow or metered connection gets only what a click asks for. */
function frugal() {
  const c = (navigator as any).connection;
  return !!c && (c.saveData || /(^|-)2g$/.test(c.effectiveType));
}

const idle = (fn: () => void, timeout = 2000) =>
  'requestIdleCallback' in window ? (window as any).requestIdleCallback(fn, { timeout }) : setTimeout(fn, 200);

export function installPrefetch() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener(
    'pointerover',
    (e) => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      const href = targetOf(e);
      clearTimeout(timer);
      if (href) timer = setTimeout(() => warmHref(href, true), 60);
    },
    { passive: true },
  );
  document.addEventListener('pointerout', () => clearTimeout(timer), { passive: true });
  for (const type of ['focusin', 'touchstart'] as const) {
    document.addEventListener(
      type,
      (e) => {
        const href = targetOf(e);
        // A touch is a click about to happen, so it gets everything; a focus is a hover with the keyboard.
        if (href) warmHref(href, type === 'focusin');
      },
      { passive: true },
    );
  }
}

/**
 * Chunks and answers the person probably needs next, loaded once the page has settled: when its requests are done and
 * the browser is idle, so speculative downloads never compete with what is on screen.
 */
export function warmWhenIdle(path: string) {
  const first = () =>
    idle(() => {
      // Both main pages and the palette are one click or keystroke away from anywhere.
      Pages.Home.preload();
      Pages.Dashboard.preload();
      Palette.preload();
      if (!frugal()) whenQuiet(second);
    }, 800);
  const second = () =>
    idle(() => {
      Pages.Settings.preload();
      Pages.Apps.preload();
      if (!isViewer()) Pages.Notifications.preload();
      if (path === '/') warmBiggestSite();
    }, 3000);
  const begin = () => whenQuiet(first);
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin, { once: true });
}

/** On Home: the site list and the overview of the site with the most visitors, the likeliest click. Two requests only. */
function warmBiggestSite() {
  const home = peek<{ sites?: { id: string; current?: { visitors?: number } }[] }>(`/api/home?period=${new URLSearchParams(window.location.search).get('period') || '30d'}`);
  const top = [...(home.data?.sites ?? [])].sort((a, b) => (b.current?.visitors ?? 0) - (a.current?.visitors ?? 0))[0];
  // dataOf lists /api/sites and the overview first; the rest waits for an actual hover or click.
  if (top) for (const url of dataOf(matchRoute(`/site/${top.id}`), window.location.search).slice(0, 2)) prefetch(url);
}
