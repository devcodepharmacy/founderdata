-- Which post paid: the owner's own X posts, matched to visits at read time (src/worker/x-posts.ts, docs/GUIDE.md
-- "Which post paid"). Every table is empty until the owner connects X or adds a post by hand.

-- One row per site that reads its X posts. The bearer token is a Worker secret (X_BEARER_TOKEN), never a column.
--   user_id        the numeric X user id, resolved once from `username` (a user read, $0.010)
--   since_id       the newest post the poll has seen, so the next poll asks only for newer ones
--   last_polled_at when the last poll ran, in ms; a dashboard read polls again once it is 10 minutes old
--   month          the UTC month (YYYY-MM) that `reads` and `spend_micros` count; a new month starts them at 0
--   reads          post reads billed this month, spend_micros their price in millionths of a US dollar
CREATE TABLE x_settings (
  site_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  user_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  since_id TEXT,
  last_polled_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  month TEXT,
  reads INTEGER NOT NULL DEFAULT 0,
  spend_micros INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- One row per post that links to the site: the polled ones and the ones added by hand.
--   id          the X post id, a string because it does not fit a double
--   created_at  when the post went out, in ms
--   paths       JSON list of the site paths its links land on, normalised (query and trailing slash removed)
--   codes       JSON list of the t.co codes of those links, for an exact match when a visit's referrer carries one
--   source      api (polled) or manual
-- 1 row written per post, no secondary index.
CREATE TABLE x_posts (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  paths TEXT NOT NULL,
  codes TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
