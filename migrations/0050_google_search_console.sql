-- Search Console through "Connect Google" (src/worker/gsc-connect.ts, src/worker/gsc-sync.ts, docs/SEO.md).
-- Both tables stay empty until the owner connects Google. The client id and secret are Worker secrets, never columns.

-- The one Google login of the deployment. `refresh_token` is AES-GCM ciphertext (`v1.<iv>.<data>`, base64) under a key
-- derived from SESSION_SECRET; the plain token is never stored.
--   status  connected, or disconnected once Google answered invalid_grant (revoked, expired, password changed)
--   error   what Google said, shown in the SEO tab
CREATE TABLE google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  error TEXT,
  connected_at INTEGER NOT NULL
);

-- One row per site that syncs from Search Console. The data lands in seo_snapshots like a pushed snapshot.
--   property        sc-domain:acme.example or https://acme.example/
--   status          active, or error when Google refused the property (the owner picks again)
--   oldest_day      earliest day fetched into gsc_queries and gsc_pages, newest_day the latest; null before the first run
--   no_data_before  the backfill stops here: Search Console has nothing older, or the 1.9 MB part is full
--   parts_at        pushed_at of gsc_queries after the sync's last write; another value means someone else pushed
--   pq_through      newest_day the gsc_page_queries part was built for
CREATE TABLE gsc_sites (
  site_id TEXT PRIMARY KEY,
  property TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  error TEXT,
  oldest_day TEXT,
  newest_day TEXT,
  no_data_before TEXT,
  parts_at INTEGER,
  pq_through TEXT,
  last_run_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
