import type { Role } from './api';
import { api } from './api';
import { installNavigation } from './nav';
import { installPrefetch } from './prefetch';
import { warmRoute } from './routes';

export interface MeResponse {
  loggedIn: boolean;
  role: Role | null;
  team?: boolean;
}

declare global {
  interface Window {
    /** The session check index.html started before any script loaded. */
    __fdMe?: Promise<MeResponse | null>;
  }
}

/**
 * The session check. The first call takes the request index.html already started (so it ran while the scripts
 * downloaded); later calls, after a login, ask again.
 */
export function checkSession(): Promise<MeResponse> {
  const early = window.__fdMe;
  window.__fdMe = undefined;
  const fresh = () => api<MeResponse>('/api/auth/me');
  return early ? early.then((r) => r ?? fresh(), fresh) : fresh();
}

/** A share link and an invite link need no session and none of the signed-in data. */
export const isPublicPath = (path: string) => /^\/(share|join)\//.test(path);

/**
 * Runs before React renders. Everything here overlaps with the script and chunk downloads that are still going:
 * the page chunk starts loading and the page's first requests start, instead of waiting for the session check and
 * then for the page to mount. A 401 (nobody signed in) throws the answers away: the cache clears on `ml:logout`.
 */
export function boot() {
  installNavigation();
  installPrefetch();
  const { pathname, search } = window.location;
  if (!isPublicPath(pathname)) warmRoute(pathname, search);

  // A deploy replaces the hashed files; a tab opened before it asks for chunks that no longer exist. Reload once
  // to pick up the new index.html (the guard stops a loop when the cause is something else).
  window.addEventListener('vite:preloadError', (e) => {
    try {
      const at = Number(sessionStorage.getItem('fd-reload') || 0);
      if (Date.now() - at < 15_000) return;
      sessionStorage.setItem('fd-reload', String(Date.now()));
    } catch {
      return;
    }
    e.preventDefault();
    window.location.reload();
  });
}
