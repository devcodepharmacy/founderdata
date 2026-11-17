-- Read-only access to one site's stats (src/worker/share.ts, docs/API.md). Two kinds of token:
--   link: the public page /share/<token> and its badge. It reads aggregates only: no visitors, journeys, names or emails.
--   api:  a read API key (Authorization: Bearer rtr_...) for /api/v1/stats/*. It cannot write, unlike sites.api_key.
-- show_revenue 0 hides revenue, payments and customers from everything the token reads. A view writes no rows:
-- deleting the row revokes the token.
CREATE TABLE share_tokens (
  token TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  show_revenue INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX share_tokens_site ON share_tokens (site_id);
