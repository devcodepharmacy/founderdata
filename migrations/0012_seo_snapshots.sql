-- SEO snapshots (src/worker/seo.ts, docs/SEO.md). Revtrail does not collect search data itself: an outside job
-- builds Search Console, keyword, SERP, AI answer and plan data per site and stores it
-- here, one row per part. A push replaces a part in place, so a push costs one row written per part (two with the
-- primary key index), whatever the size of the data.
CREATE TABLE seo_snapshots (
  site_id TEXT NOT NULL,
  part TEXT NOT NULL,          -- meta, gsc_daily, gsc_queries, gsc_pages
  json TEXT NOT NULL,          -- the part as the pusher sent it; never parsed by the Worker
  pushed_at INTEGER NOT NULL,  -- ms
  PRIMARY KEY (site_id, part)
);
