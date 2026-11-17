-- Next actions, the alert inbox and rule webhooks that wake a runner (docs/API.md "Next actions", "Alert inbox" and
-- "Alert rules", docs/GUIDE.md "Run an agent on a schedule").

-- Each site's next actions (src/worker/actions.ts), computed once a day on the minute-50 tick: decaying pages, queries
-- near page one, fatigued Meta ads, Apple Search Ads campaigns below 0.5 ROAS, MRR on failed renewals, AI prompts that
-- lost their mention and integrations that fail. One row per site: the run claims it (day and computed_at), then
-- writes the items, so a day costs 2 rows a site.
--   day          the UTC day the row was computed for, YYYY-MM-DD
--   computed_at  ms timestamp of the run
--   items        JSON array of the site's items, highest value first (actions.ts ActionItem)
CREATE TABLE action_items (
  site_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  items TEXT NOT NULL DEFAULT '[]'
) WITHOUT ROWID;

-- Every alert message FounderData produced, one row per message and site, never per channel (src/worker/alert-events.ts):
-- Worth a look, payments stopped, failed payments and cancellations, refused webhooks, the write cap, the ASO collector
-- and reviews, threshold rules that fired and the weekly report. Purchases and renewals stay out: payments hold them.
-- Names, emails and customer ids stay out too. The key starts with ts, so GET /api/v1/alerts?since= reads a range of
-- the primary key and needs no other index: an insert writes 1 row. The 03:17 cleanup deletes rows past 90 days.
--   site_id  NULL for a message about no one site (the shared write cap); only a key for every site reads those
--   data     JSON with the message's numbers, as the JSON webhook sends them, without personal fields
CREATE TABLE alert_events (
  ts INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  site_id TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (ts, id)
) WITHOUT ROWID;

-- Rule webhooks that wake a runner without a relay (src/worker/alert-rules.ts sendWebhook):
--   auth_header  the Authorization header value sent with each delivery, such as "Bearer <token>"; never read back
--   format       founderdata (the documented payload) or github_dispatch ({"event_type", "client_payload"} for
--                POST https://api.github.com/repos/OWNER/REPO/dispatches)
ALTER TABLE alert_rules ADD COLUMN auth_header TEXT;
ALTER TABLE alert_rules ADD COLUMN format TEXT NOT NULL DEFAULT 'founderdata';

-- The weekly report's sent markers reuse numbers_sent (migration 0057) with channel_id 'weekly:<channel id>' and the
-- Monday's UTC day, so the report goes out once per channel and a refused send is tried again on later Monday ticks.
