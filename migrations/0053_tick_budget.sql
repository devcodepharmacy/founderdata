-- Round-4 fixes for the 5-minute tick and Search Console (docs/ASO.md, docs/AI-VISIBILITY.md, docs/SEO.md).
--
-- cron_state: small facts the cron records for the dashboard. `tick_minutes` is the time between rank and AI runs the
-- cron last ran with (5 on the */5 cron, 60 on the old hourly one), so the tab states the real number of results a day.
-- Written when the value changes or is older than 6 hours: about 4 rows a day, none on a quiet tick.
CREATE TABLE cron_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;

-- ai_claims: one row per check (site, UTC day, engine, prompt) while an engine call is in flight. A run claims a check
-- with one upsert before it calls the engine, and a claim younger than 2 minutes stops an overlapping run from calling
-- the same engine for the same check (and the provider from billing it twice). 1 row written per check.
CREATE TABLE ai_claims (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, engine, prompt_id)
) WITHOUT ROWID;

-- A collected check that keeps failing (DataForSEO says it is ready, task_get answers with a code the cron does not handle)
-- counts its failures and waits before the next try, so it cannot hold the collect budget until STALE_TASK_DAYS drops it.
-- task_fails resets to 0 when a new check is posted for the keyword or pair.
ALTER TABLE rank_keywords ADD COLUMN task_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rank_keywords ADD COLUMN task_retry_at INTEGER;
ALTER TABLE aso_rank_tasks ADD COLUMN task_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aso_rank_tasks ADD COLUMN task_retry_at INTEGER;

-- Open hosted App Store checks, found without scanning every pair of the app. A pair is open while task_id is a real id.
CREATE INDEX aso_rank_tasks_open ON aso_rank_tasks (task_day) WHERE task_id IS NOT NULL AND task_id NOT LIKE 'pending:%';

-- The UTC day on which the cron found nothing left to post for a site, so the next ticks of that day skip the scan of its
-- keywords (Google) or pairs (App Store). Adding a keyword, changing countries, or turning ranks on clears it.
ALTER TABLE rank_settings ADD COLUMN done_day TEXT;
ALTER TABLE aso_settings ADD COLUMN hosted_done_day TEXT;

-- Who connected Google (docs/SEO.md "Connect Google"): the owner, or the teammate's name. One grant serves the deployment.
ALTER TABLE google_auth ADD COLUMN connected_by TEXT;

-- Search Console: the last `end` day (three days before today) the sync's probe looked at. A day Search Console has not
-- published yet is not stored as covered; this column only stops the sync from probing the same range again the same day.
ALTER TABLE gsc_sites ADD COLUMN probed_through TEXT;
