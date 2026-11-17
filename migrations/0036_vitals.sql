-- Core Web Vitals from real visitors (src/worker/vitals.ts, docs/GUIDE.md "Page speed"). The tracker measures LCP,
-- INP, CLS, TTFB and FCP in the browser and sends them once per page load, inside the engaged-time ping it sends
-- when the page is hidden. No visitor or session id is stored with them: a row says how fast a page was, not for whom.
--   vitals_sample   percent of page loads whose vitals are stored, 0 to 100. 0 turns them off.
ALTER TABLE sites ADD COLUMN vitals_sample INTEGER NOT NULL DEFAULT 100;

-- One row per measured page load. WITHOUT ROWID with no other index: a beacon writes 1 row. Reads go by site_id and
-- ts, the first two key columns; `id` is random and keeps two loads in the same millisecond apart.
CREATE TABLE vitals (
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- ms, when the beacon arrived
  id INTEGER NOT NULL,
  path TEXT NOT NULL,           -- the page path, as the events table stores it
  device TEXT,                  -- Desktop, Mobile or Tablet, as sessions.device
  lcp INTEGER,                  -- Largest Contentful Paint, ms; NULL when the browser does not report it
  inp INTEGER,                  -- Interaction to Next Paint, ms; NULL without an interaction
  cls REAL,                     -- Cumulative Layout Shift, unitless
  ttfb INTEGER,                 -- Time to First Byte, ms
  fcp INTEGER,                  -- First Contentful Paint, ms
  PRIMARY KEY (site_id, ts, id)
) WITHOUT ROWID;
