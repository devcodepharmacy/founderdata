-- Subscription history imported from ChartMogul or RevenueCat (src/worker/sub-import.ts, docs/GUIDE.md "Import from
-- ChartMogul" and "Import from RevenueCat").

-- One row per import: its progress, the ChartMogul cursor (never the API key) and the last verification.
CREATE TABLE sub_imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- chartmogul or revenuecat
  status TEXT NOT NULL,            -- fetching, building, done
  cursor TEXT,                     -- ChartMogul: the cursor of the next activities page
  pages INTEGER NOT NULL DEFAULT 0,    -- activity pages stored
  fetched INTEGER NOT NULL DEFAULT 0,  -- activities read
  rows_sent INTEGER NOT NULL DEFAULT 0,  -- subscriptions the browser has sent, in order: where a resume continues
  created INTEGER NOT NULL DEFAULT 0,  -- rows added
  merged INTEGER NOT NULL DEFAULT 0,   -- native rows that got earlier history
  skipped INTEGER NOT NULL DEFAULT 0,  -- subscriptions left out (native data wins, or another import has them)
  error TEXT,
  verify TEXT,                     -- JSON: the last month-end comparison
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX sub_imports_site ON sub_imports(site_id, created_at);

-- ChartMogul activities as fetched, compacted, one row per page, so a closed tab resumes and the browser builds the
-- timelines from them (the Worker's CPU time per request is too short for it).
CREATE TABLE sub_import_pages (
  import_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (import_id, n)
) WITHOUT ROWID;

-- steps: JSON [[ms, mrr], ...], the price changes between the first payment and mrr_changed_at (a row with a price
--   history has '[]' or more; native rows have NULL). mrr_changed_at and mrr stay the last change.
-- import_id: the import that made the row, or that gave a native row earlier history.
-- import_undo: JSON of the native row's own values before that history was added, NULL on a row the import made.
ALTER TABLE subscriptions ADD COLUMN steps TEXT;
ALTER TABLE subscriptions ADD COLUMN import_id TEXT;
ALTER TABLE subscriptions ADD COLUMN import_undo TEXT;
