/**
 * Apple Search Ads names for ids in breakdown rows (pro/worker/asa.ts imports them). Apart from asa.ts so stats.ts
 * and appstats.ts can use it without loading the import code.
 */

/** Which kind of Apple Search Ads id a session dimension holds (src/worker/adservices.ts sets them). */
export const ASA_KINDS: Record<string, 'campaign' | 'keyword' | 'adgroup'> = {
  campaign: 'campaign',
  utm_campaign: 'campaign',
  keyword: 'keyword',
  utm_term: 'keyword',
  utm_content: 'adgroup',
};

/** Ids Apple hands out are numbers. Labels like "launch-tweet" never need a lookup. */
const NUMERIC = /^\d{1,20}$/;

/** id → name for the given ids of one kind. One indexed read; none when no id looks like Apple's. */
export async function asaNames(db: D1Database, kind: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id && NUMERIC.test(id)))];
  if (!wanted.length) return new Map();
  // A missing name never breaks a panel: before migration 0019 the table does not exist, and the id shows.
  const res = await db
    .prepare('SELECT id, name FROM asa_names WHERE kind = ? AND id IN (SELECT value FROM json_each(?)) AND name IS NOT NULL')
    .bind(kind, JSON.stringify(wanted))
    .all<{ id: string; name: string }>()
    .catch(() => ({ results: [] as { id: string; name: string }[] }));
  return new Map(res.results.map((r) => [r.id, r.name]));
}

/** Sets `name` on rows whose label is an Apple Search Ads id with a known name. The label stays the id, for filters. */
export async function withAsaNames<T extends { label: string | null; name?: string | null }>(db: D1Database, dim: string, rows: T[]): Promise<T[]> {
  const kind = ASA_KINDS[dim];
  if (!kind) return rows;
  const names = await asaNames(db, kind, rows.map((r) => r.label));
  for (const r of rows) {
    const name = r.label ? names.get(r.label) : undefined;
    if (name) r.name = name;
  }
  return rows;
}
