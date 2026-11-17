-- Erase log (src/worker/privacy.ts, docs/PRIVACY.md): one row per erase request, so the owner can show when a data
-- subject request was handled. It holds no personal data: the site, the time, how the person was found (visitor,
-- email, user_id) and how many rows each table lost, never the id, email or user id itself.
-- WITHOUT ROWID keyed by site and time: a request writes 1 row.
CREATE TABLE erasures (
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,         -- ms
  id TEXT NOT NULL,            -- random, tells two requests in the same millisecond apart
  method TEXT NOT NULL,        -- visitor, email, user_id, or email+user_id
  counts TEXT NOT NULL,        -- JSON: rows removed or cleared per kind, as the erase route answered
  PRIMARY KEY (site_id, ts, id)
) WITHOUT ROWID;
