import { useEffect, useState } from 'react';

/** The location's path, updated on back, forward and navigate() (App.tsx sends popstate for both). */
export function usePathname() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

/**
 * The Content tab's detail for one entry page: /site/:id/content/page/blog/x for /blog/x. The page path rides in
 * the URL path, not the query, so the period and filters in the query (useQueryState) stay as they are.
 */
export function contentPageUrl(siteId: string, page: string, search: string = window.location.search) {
  return `/site/${siteId}/content/page${encodeURI(page.startsWith('/') ? page : `/${page}`)}${search}`;
}

/** The entry page a /site/:id/content/page/... path is for, or null on the Content list. */
export function contentPageOf(pathname: string): string | null {
  const m = /\/content\/page(\/.*)?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURI(m[1] || '/');
  } catch {
    return m[1] || '/';
  }
}
