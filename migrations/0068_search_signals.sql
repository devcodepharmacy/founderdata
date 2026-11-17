-- Search signals (docs/SEO.md "Search totals" and "SERP competitors"). Every column rides on a row that is already
-- written, so a rank check and a sync step cost the same rows as before.

-- The SERP around each tracked keyword, from the result the rank check already pays for (src/shared/ranks.ts parseSerp).
-- Both are JSON text, NULL for checks from before this migration and for a check with no results.
--   serp_top       the first 10 organic results: [[rank, domain, url], ...]. No title or snippet: strangers write those.
--   serp_features  {"types": ["featured_snippet", ...], "snippet": "domain or null", "paa": ["question", ...]}
ALTER TABLE ranks ADD COLUMN serp_top TEXT;
ALTER TABLE ranks ADD COLUMN serp_features TEXT;

-- The newest Search Console day the gsc_page_totals (pt_through) and gsc_query_totals (qt_through) parts were built
-- for: every page or query over 28 days, the 28 before and the last 7 (src/worker/gsc-sync.ts).
ALTER TABLE gsc_sites ADD COLUMN pt_through TEXT;
ALTER TABLE gsc_sites ADD COLUMN qt_through TEXT;
