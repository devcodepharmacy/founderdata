// The product itself, not a deployment (docs/PRO.md): which edition this build is, its version, and where updates and
// FounderData Pro come from. A self-hoster never edits this file; deployment data goes in the gitignored files that
// AGENTS.md lists.
import pkg from '../../package.json';

/** The version this build was made from (package.json). Core and Pro share version numbers. */
export const VERSION: string = pkg.version;

/** The public core repository. Updates to core are merged from here. */
export const CORE_REPO = 'https://github.com/datPascal/founderdata';

/** The private FounderData Pro repository. A buyer's GitHub account gets read access when they buy. */
export const PRO_REPO = 'https://github.com/datPascal/founderdata-pro';

/** The latest release, as JSON ({ version, date, notes }). The Updates card in Settings reads it in the browser. */
export const RELEASE_URL = 'https://raw.githubusercontent.com/datPascal/founderdata/main/release.json';

/**
 * The Polar checkout for the lifetime license. Empty until the product exists on Polar: the Pro card then links to
 * PRO_PAGE instead.
 */
export const PRO_CHECKOUT_URL = '';

/** What Pro adds and costs, in the core README. */
export const PRO_PAGE = `${CORE_REPO}#founderdata-pro`;

export interface Release {
  version: string;
  date: string;
  notes?: string;
}

/** -1, 0 or 1 for two dotted versions such as 1.4.0 and 1.10.2. A part that is not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
