-- Chart notes (src/worker/notes.ts, docs/GUIDE.md "Chart notes"): a launch, a deploy, a price change, shown as a
-- marker on the site's main chart. kind is manual (added in the dashboard), api (POST /api/v1/notes) or version
-- (the daily cron saw an app version for the first time). A note costs 3 rows written: the row and two indexes.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,         -- ms, the moment the note is about
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_site_time ON notes (site_id, ts);
