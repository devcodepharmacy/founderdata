// Which post paid: matching a visit from X to one of the owner's own posts (docs/GUIDE.md, "Which post paid").
// Pure code, shared by the Worker and the tests. A visit is matched at read time, never when it is stored.

/** A visit counts for a post that went out at most this long before it. */
export const WINDOW_MS = 48 * 3_600_000;
/** Shown for visits from X that match no stored post (bio links, posts that were not read, posts older than the window). */
export const NO_POST = 'X, no matching post';

/** The hostnames a visit from X can carry as its referrer domain, and the Android app's package (stored as source X since sources.ts knows it). */
export function isXReferrerDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return d === 't.co' || d === 'x.com' || d === 'twitter.com' || d.endsWith('.x.com') || d.endsWith('.twitter.com') || d === 'com.twitter.android';
}

/** A path the way the tracker stores it (src/worker/collect.ts normalizePath), without query or fragment, and lower case. */
export function normalizeLandingPath(pathname: string | null | undefined): string {
  let p = (pathname ?? '/').split(/[?#]/)[0] || '/';
  try {
    p = decodeURI(p);
  } catch {
    // keep the raw path
  }
  p = p.toLowerCase();
  p = p.replace(/\/index(\.html?)?$/, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500) || '/';
}

const stripWww = (h: string) => h.replace(/^www\./, '').toLowerCase();
const onDomain = (host: string, domain: string) => {
  const h = stripWww(host);
  const d = stripWww(domain);
  return h === d || h.endsWith('.' + d);
};

/** The landing path of a link, or null when the link does not point at the site's domain (or is not a URL). */
export function landingPathOf(url: string, domain: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !onDomain(u.hostname, domain)) return null;
    return normalizeLandingPath(u.pathname);
  } catch {
    return null;
  }
}

/** The code of a https://t.co/<code> link, or null. */
export function tcoCode(url: string): string | null {
  const m = /^https?:\/\/t\.co\/([A-Za-z0-9]{4,40})\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

export interface PostKey {
  id: string;
  created_at: number;
  paths: string[];
  codes: string[];
}
export interface VisitKey {
  started_at: number;
  entry_page: string | null;
  /** What the tracker stored: hostname plus path, like `t.co` or `t.co/AbC123xyz`. */
  referrer: string | null;
}
export type Match = { post: PostKey; kind: 'exact' | 'probable' } | null;

/**
 * Posts indexed once per report: t.co code -> post, and landing path -> posts oldest first (ties by id). A visit then
 * checks one code lookup and one binary search instead of every post. `probes` counts the steps, for the tests.
 */
export interface PostIndex {
  byCode: Map<string, PostKey>;
  byPath: Map<string, { post: PostKey; id: bigint }[]>;
  probes: number;
}

export function indexPosts(posts: PostKey[]): PostIndex {
  const idx: PostIndex = { byCode: new Map(), byPath: new Map(), probes: 0 };
  for (const p of posts) {
    for (const c of p.codes) if (!idx.byCode.has(c)) idx.byCode.set(c, p);
    for (const path of p.paths) {
      const list = idx.byPath.get(path) ?? idx.byPath.set(path, []).get(path)!;
      list.push({ post: p, id: BigInt(p.id) });
    }
  }
  for (const list of idx.byPath.values()) list.sort((a, b) => (a.post.created_at !== b.post.created_at ? a.post.created_at - b.post.created_at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return idx;
}

/** The post a visit from X is credited to, using an index. Same rules as matchVisit. */
export function matchIndexed(v: VisitKey, idx: PostIndex): Match {
  const ref = (v.referrer ?? '').trim();
  const m = /^t\.co\/([A-Za-z0-9]+)/i.exec(ref);
  idx.probes++;
  if (m) {
    const hit = idx.byCode.get(m[1]);
    if (hit) return { post: hit, kind: 'exact' };
  }
  if (!v.entry_page) return null;
  const list = idx.byPath.get(normalizeLandingPath(v.entry_page));
  if (!list) return null;
  // The last post that went out at or before the visit: the closest earlier one. If it is outside the window, so are all older ones.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    idx.probes++;
    const mid = (lo + hi) >> 1;
    if (list[mid].post.created_at <= v.started_at) lo = mid + 1;
    else hi = mid;
  }
  if (!lo) return null;
  const best = list[lo - 1].post;
  return v.started_at - best.created_at < WINDOW_MS ? { post: best, kind: 'probable' } : null;
}

/**
 * The post a visit from X is credited to.
 * 1. Exact: the referrer carries the post's t.co code (`t.co/<code>`). The window and the landing page do not matter.
 * 2. Probable: the visit started 0 to 48 hours after the post and landed on a path one of the post's links points at.
 *    With several such posts the closest earlier one wins; at the same millisecond the higher id (the newer post) wins.
 * Anything else matches no post.
 */
export function matchVisit(v: VisitKey, posts: PostKey[]): Match {
  return matchIndexed(v, indexPosts(posts));
}

/** The status id in an x.com or twitter.com post URL, or null. */
export function postIdOf(url: string): string | null {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i)\/(?:web\/)?status(?:es)?\/(\d{5,25})/.exec(url.trim());
  return m ? m[1] : null;
}

/** The handle in an x.com or twitter.com post URL, or null (also for the `i` placeholder). */
export function postHandleOf(url: string): string | null {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/(?:web\/)?status(?:es)?\/\d{5,25}/.exec(url.trim());
  return m && m[1] !== 'i' ? m[1] : null;
}

/** The https URLs in a text, for a post added by hand. */
export function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((u) => u.replace(/[).,;!?]+$/, ''));
}

/**
 * "3 exact · 41 probable": how a post's visits, customers or revenue split by how the visit was matched. The caller
 * formats each number. A zero side stays in the text, so a reader sees that nothing was certain rather than guessing.
 */
export function matchSplit(exact: string, probable: string): string {
  return `${exact} exact · ${probable} probable`;
}
