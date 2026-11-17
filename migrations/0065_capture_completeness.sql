-- Capture completeness: ad click ids, first touch, browser language and datacenter traffic (docs/PRIVACY.md,
-- docs/GUIDE.md "Ad clicks other than Meta" and "Datacenter visits"). Every column rides on a row the tracker already
-- writes, and none is indexed, so a visit writes no extra row.

-- The ad click a session landed with, for networks other than Meta (src/shared/sources.ts CLICK_NETWORKS):
--   click_network  google_ads, microsoft_ads, tiktok_ads, x_ads, linkedin_ads, reddit_ads, snapchat_ads or pinterest_ads;
--                  the session's channel is Paid and its source the network's ("Google Ads")
--   click_id       the raw id (gclid, gbraid, wbraid, msclkid, ttclid, twclid, li_fat_id, rdt_cid, ScCid or epik), for an
--                  offline conversion upload. Cleared 90 days after the visit (src/worker/retention.ts pruneClickIds);
--                  click_network stays, it names a network, not a person
--   click_at       when FounderData saw the click
ALTER TABLE sessions ADD COLUMN click_network TEXT;
ALTER TABLE sessions ADD COLUMN click_id TEXT;
ALTER TABLE sessions ADD COLUMN click_at INTEGER;

-- The browser's first language from the Accept-Language header, the primary subtag only ("de", "pt").
ALTER TABLE sessions ADD COLUMN language TEXT;

-- 1 when the visit came from a hosting network (AWS, Google Cloud, Azure, Hetzner and others, src/worker/datacenter.ts):
-- almost always a bot with a browser's user agent. Hidden from the numbers unless sites.show_datacenter is 1. Events
-- carry the same flag, so page and goal panels hide them without reading sessions.
ALTER TABLE sessions ADD COLUMN datacenter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN datacenter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN show_datacenter INTEGER NOT NULL DEFAULT 0;

-- First touch: where the visitor's first visit came from, written by the INSERT OR IGNORE that creates the visitor row,
-- so the first visit wins and later visits change nothing. Visitors created before this migration have none; reads
-- fall back to the credited visit (src/worker/stats.ts, model=first).
ALTER TABLE visitors ADD COLUMN first_source TEXT;
ALTER TABLE visitors ADD COLUMN first_channel TEXT;
ALTER TABLE visitors ADD COLUMN first_campaign TEXT;
ALTER TABLE visitors ADD COLUMN first_referrer TEXT;
ALTER TABLE visitors ADD COLUMN first_entry_page TEXT;
