-- Daily write cap per site (src/worker/budget.ts, docs/GUIDE.md "Daily write cap"). The tracker and app endpoints
-- are public, so anyone with a site id can send events. The cap stops a flood of fake events from using up the free
-- plan's rows, or running up a Workers Paid bill.
ALTER TABLE sites ADD COLUMN write_cap_on INTEGER NOT NULL DEFAULT 1;
-- Rows written a day. NULL: automatic, 80% of the free plan's 100,000 split evenly across all sites.
ALTER TABLE sites ADD COLUMN write_cap INTEGER;

-- Rows the tracker and app endpoints wrote today (UTC), one row per site that is reset when the day changes. Each
-- Worker instance adds its count every few hundred rows, so the number lags behind by at most that much.
CREATE TABLE site_usage (
  site_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,           -- UTC date, YYYY-MM-DD
  rows INTEGER NOT NULL,
  capped_at INTEGER            -- ms when the cap was first reached on `day`, else NULL
) WITHOUT ROWID;
