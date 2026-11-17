-- Hosted App Store ranks: a daily rank per keyword and country from DataForSEO's App Data API, on the owner's own
-- DataForSEO account (src/worker/aso-hosted.ts, docs/ASO.md "Ranks without your Mac"). Nothing runs until the owner turns
-- it on for an app.

-- Per app: 1 = the cron checks every keyword in every country daily. hosted_error is why the last run stopped (cap
-- reached, no funds, no App Store id), NULL when it worked.
ALTER TABLE aso_settings ADD COLUMN hosted_ranks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aso_settings ADD COLUMN hosted_error TEXT;

-- Where each keyword's rank in a snapshot came from: {"<keyword>": "dataforseo" | "import"}. A keyword without an entry
-- came from the collector. A collector push removes the entries of the keywords it writes.
ALTER TABLE aso_snapshots ADD COLUMN rank_src TEXT;

-- What the hosted App Store checks cost, per site and month, so the cap can estimate the next batch from the last ones.
-- micros (the month's whole spend) is shared with rank tracking and research; these two count only the app checks.
ALTER TABLE dfs_spend ADD COLUMN aso_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dfs_spend ADD COLUMN aso_tasks INTEGER NOT NULL DEFAULT 0;

-- The check posted last for each keyword and country. task_id is 'pending:<run>' while the cron claims the pair, then the
-- DataForSEO task id until the result is collected, then NULL. task_day is the UTC day of the check, so a pair with
-- task_day = today has been checked or is open, and is never posted twice. Rows stay when a keyword is removed, so
-- removing and adding it back the same day does not pay again; the cron drops rows older than 7 days whose keyword
-- or country is gone. 1 row written per claim, 1 per task id, 1 per collected result.
CREATE TABLE aso_rank_tasks (
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  country TEXT NOT NULL,
  task_id TEXT,
  task_day TEXT,
  PRIMARY KEY (site_id, keyword, country)
) WITHOUT ROWID;
