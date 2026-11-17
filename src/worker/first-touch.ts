// First touch: where a visitor's first visit came from (visitors.first_*, migration 0065; docs/GUIDE.md "First touch").

/** A visitor row another path created this long before the first visit still takes that visit as its first touch. */
export const FIRST_TOUCH_FILL_MS = 600_000;

/**
 * A visit stored as Direct that turns out to come from an ad (Apple's answer, or an ad click id on a later page) moves
 * the visitor's first touch with it, when that visit is the visitor's first: first seen no earlier than a minute before
 * the visit started. Matches no row, so writes nothing, for a returning visitor or one whose first touch is not Direct.
 */
export function upgradeFirstTouch(db: D1Database, siteId: string, sessionId: string, source: string, campaign: string | null) {
  return db
    .prepare(
      `UPDATE visitors SET first_channel = 'Paid', first_source = ?1, first_campaign = COALESCE(?2, first_campaign)
       WHERE site_id = ?3 AND id = (SELECT visitor_id FROM sessions WHERE site_id = ?3 AND id = ?4)
         AND first_channel = 'Direct'
         AND first_seen >= (SELECT started_at FROM sessions WHERE site_id = ?3 AND id = ?4) - 60000`,
    )
    .bind(source, campaign, siteId, sessionId);
}
