-- Google rank tracking and keyword research on the owner's own DataForSEO account (src/worker/dataforseo.ts,
-- docs/SEO.md "Keyword research and rank tracking"). The login is a Worker secret (DATAFORSEO_LOGIN and
-- DATAFORSEO_PASSWORD), never a column. Every table is empty until the owner turns tracking on for a site.

-- One row per site that tracks ranks. A row exists once the owner saves settings or adds a keyword.
--   enabled             1 = the cron posts tasks; 0 = paused
--   location_code       DataForSEO location (2840 is the United States), language_code its language ("en")
--   device              desktop or mobile
--   depth               results per check, 10 to 100 in steps of 10. A deeper check can cost more.
--   ai_overview         1 = ask DataForSEO to load the AI Overview, which adds a charge per check
--   monthly_cap_micros  the most this site may spend a month, in millionths of a US dollar. 0 stops all spending.
--   last_error          why the last post failed or stopped (cap reached, no funds), NULL when it worked
CREATE TABLE rank_settings (
  site_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  location_code INTEGER NOT NULL DEFAULT 2840,
  language_code TEXT NOT NULL DEFAULT 'en',
  device TEXT NOT NULL DEFAULT 'desktop',
  depth INTEGER NOT NULL DEFAULT 20,
  ai_overview INTEGER NOT NULL DEFAULT 0,
  monthly_cap_micros INTEGER NOT NULL DEFAULT 5000000,
  last_error TEXT,
  last_error_at INTEGER
) WITHOUT ROWID;

-- The keywords a site tracks, at most 200 each. task_id and task_day are the check the cron posted last: the result
-- is collected on a later run, and the check counts as open while ranks has no row for (keyword, task_day).
CREATE TABLE rank_keywords (
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  task_id TEXT,
  task_day TEXT,
  PRIMARY KEY (site_id, keyword)
) WITHOUT ROWID;

-- One row per keyword and day (UTC): the site's best organic position in the checked results, its URL, and the AI
-- Overview. position is NULL when the site is not in the first `depth` results. aio is 1 or 0, NULL when the AI
-- Overview was not requested and none came back. aio_cited is 1 when the AI Overview links to the site.
-- 1 row written per check.
CREATE TABLE ranks (
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  day TEXT NOT NULL,
  position INTEGER,
  url TEXT,
  aio INTEGER,
  aio_cited INTEGER,
  PRIMARY KEY (site_id, keyword, day)
) WITHOUT ROWID;

-- What DataForSEO charged, per site and month (YYYY-MM, UTC), from the `cost` each answer returns. micros is every
-- call; post_micros and post_tasks only the rank checks, so the cap can estimate the next batch from what the
-- last ones cost.
CREATE TABLE dfs_spend (
  site_id TEXT NOT NULL,
  month TEXT NOT NULL,
  micros INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  post_micros INTEGER NOT NULL DEFAULT 0,
  post_tasks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, month)
) WITHOUT ROWID;
