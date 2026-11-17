-- History imported from another analytics tool (src/worker/imports.ts, docs/GUIDE.md "Import from Plausible").
-- Imported data is stored as daily aggregates and never touches sessions, events or payments: native rows stay as
-- they are, and a query adds imported days only for dates before the site's first native visit.

-- One row per import, so one import can be deleted in one call.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- the tool the data came from: plausible
  status TEXT NOT NULL,           -- importing, then done
  from_day TEXT NOT NULL,         -- first and last day the import covers, YYYY-MM-DD in the site's timezone
  to_day TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,      -- day-rows stored so far
  files TEXT,                     -- JSON: the files that were read, with their row counts
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX imports_site ON imports(site_id, from_day);

-- One row per kind per day. `kind` is visitors (data: {"v","p","s","b","d"}: visitors, pageviews, visits, bounced
-- visits, visit seconds) or a panel (source, campaign, keyword, page, entry_page, exit_page, country, device, browser,
-- os, goal), whose data maps a label to [visitors, pageviews]. The key starts with site_id, kind and day, so a read
-- over a date range is one seek. No other index: a stored row costs 1 D1 row written.
CREATE TABLE imported_daily (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD in the site's timezone
  import_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (site_id, kind, day, import_id)
) WITHOUT ROWID;
