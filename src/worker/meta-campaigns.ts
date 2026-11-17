/**
 * Which Campaign rows of a breakdown are Meta ad campaigns, so the dashboard's row menu offers "Open Meta ads" only for
 * them (src/dashboard/lib/rowActions.ts). The guide's URL parameters put `utm_campaign={{campaign.name}}` on every ad
 * (docs/GUIDE.md, "Meta ads"), so a label matches a campaign of the site's ad account by name, or by id for links
 * built by hand. A newsletter, Google Ads or affiliate campaign matches none.
 */

/** The breakdown dimensions that hold utm_campaign. */
const CAMPAIGN_DIMS = new Set(['campaign', 'utm_campaign']);

/** Sets `meta` on rows whose label is a campaign of the site's Meta ad account. One read; none for other dimensions. */
export async function withMetaCampaigns<T extends { label: string | null; meta?: boolean }>(db: D1Database, siteId: string, dim: string, rows: T[]): Promise<T[]> {
  if (!CAMPAIGN_DIMS.has(dim)) return rows;
  const labels = [...new Set(rows.map((r) => r.label?.trim().toLowerCase()).filter((l): l is string => !!l))];
  if (!labels.length) return rows;
  // No Meta settings, or a database before migration 0060: no row is flagged and the menu leaves Meta ads out.
  const res = await db
    .prepare(
      `SELECT lower(o.id) AS id, lower(o.name) AS name FROM meta_settings m
       JOIN meta_objects o ON o.account_id = m.ad_account_id AND o.kind = 'campaign'
       WHERE m.site_id = ?1 AND (lower(o.name) IN (SELECT value FROM json_each(?2)) OR o.id IN (SELECT value FROM json_each(?2)))`,
    )
    .bind(siteId, JSON.stringify(labels))
    .all<{ id: string; name: string | null }>()
    .catch(() => ({ results: [] as { id: string; name: string | null }[] }));
  if (!res.results.length) return rows;
  const known = new Set(res.results.flatMap((r) => [r.id, r.name].filter((v): v is string => !!v)));
  for (const r of rows) if (r.label && known.has(r.label.trim().toLowerCase())) r.meta = true;
  return rows;
}

/** A visit from Meta: an ad id in the landing URL, or a paid visit whose source is one of Meta's apps. */
export const META_VISIT = `(s.ad_id IS NOT NULL OR (s.channel = 'Paid' AND s.source IN ('Facebook', 'Instagram', 'Messenger', 'Audience Network', 'Meta')))`;
