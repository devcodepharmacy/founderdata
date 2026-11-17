-- Deployment-wide settings (src/worker/reporting.ts, docs/API.md "Reporting timezone"). One row per key.
--   reporting_timezone  the IANA timezone Home, the iPhone's Home, /api/v1/portfolio, /api/v1/weekly and the Monday
--                       report count days in. No row: the timezone every site shares, else UTC.
-- Saving a setting writes 1 row.
CREATE TABLE deployment_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL  -- ms
) WITHOUT ROWID;
