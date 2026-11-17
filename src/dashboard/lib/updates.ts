import { compareVersions, type Release } from '../../shared/product';

/** The answer of RELEASE_URL as a Release, or null when it is not JSON with a version (a 404 page, a proxy's HTML). */
export function parseRelease(text: string): Release | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  if (typeof r.version !== 'string' || !/^\d+(\.\d+)*$/.test(r.version)) return null;
  return { version: r.version, date: typeof r.date === 'string' ? r.date : '', notes: typeof r.notes === 'string' ? r.notes : undefined };
}

/** The newer release to offer, or null when this deployment runs the latest one or a later build. */
export function newerRelease(current: string, latest: Release): Release | null {
  return compareVersions(latest.version, current) > 0 ? latest : null;
}
