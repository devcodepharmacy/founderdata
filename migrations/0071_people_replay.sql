-- People and recordings (docs/GUIDE.md, "People and recordings (Pro)"; docs/PRIVACY.md, "Recordings").
-- The switches live on the site row, traits on the visitor row, and one index row per recorded visit. The recording
-- itself is in the optional R2 bucket REPLAY_BUCKET (`npm run setup -- --replay`), never in D1.

-- Record visits (FounderData Pro): off by default.
--   record_visits       1 = the tracker loads /js/replay.js for visits the server picks
--   record_sample       percent of visits recorded, 1 to 100
--   record_keep_days    days a recording is kept: 7, 30 or 90
--   record_daily_max    most visits recorded a day
--   record_only_active  1 = after 24 hours keep only visits with a goal or a payment
-- Remember visitors: 1 = the tracker keeps a visitor id in first-party cookies, as after founderdata('consent', true).
ALTER TABLE sites ADD COLUMN record_visits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN record_sample INTEGER NOT NULL DEFAULT 100;
ALTER TABLE sites ADD COLUMN record_keep_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE sites ADD COLUMN record_daily_max INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE sites ADD COLUMN record_only_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN remember_visitors INTEGER NOT NULL DEFAULT 0;

-- Extra keys passed to identify(), as a JSON object: at most 20 keys matching [a-z0-9_]{1,40}, values clipped to 100
-- characters (src/worker/collect.ts traitsOf). Rides on the visitors row identify() already updates.
ALTER TABLE visitors ADD COLUMN traits TEXT;

-- One row per recorded visit, written with its first chunk. The chunks are R2 objects r/<site_id>/<session_id>/<n>.
CREATE TABLE replays (
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  entry_page TEXT,
  PRIMARY KEY (site_id, session_id)
);
CREATE INDEX idx_replays_started ON replays (site_id, started_at);
CREATE INDEX idx_replays_visitor ON replays (site_id, visitor_id);

-- Page activity (clicks, rage clicks and errors of one page) is an events row with type 'activity', no new table.
