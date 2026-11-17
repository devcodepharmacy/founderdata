-- Keywords removed from rank tracking keep their last check here for 3 days (src/worker/dataforseo.ts), so removing a
-- keyword and adding it again the same day does not pay for a second check. addKeywords copies task_id and task_day
-- back onto the new row and deletes the tombstone; the cron drops tombstones older than the stale-task window.
CREATE TABLE rank_removed (
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  task_id TEXT,
  task_day TEXT,
  removed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, keyword)
) WITHOUT ROWID;
