-- Threshold alert rules (src/worker/alert-rules.ts, docs/GUIDE.md "Threshold alerts", docs/API.md "Alert rules"): per
-- site, "revenue per visitor fell 15% in 7 days" and the like, checked by the 07:00 UTC cron. A rule that crosses its
-- line fires once, to a signed webhook, the notification channels and the iPhone app, then waits until the metric is
-- back over the line before it can fire again.
--   metric        visitors, revenue, revenue_per_visitor, conversion_rate, page_google_clicks or ai_visits
--   path          page_google_clicks only: the page path, NULL for any page
--   comparison    falls_pct, rises_pct or drops_below
--   threshold     percent for falls_pct and rises_pct; for drops_below the metric's own unit (minor units of money,
--                 a 0 to 1 fraction for conversion_rate)
--   win           24h or 7d
--   min_volume    the rule is skipped while the visitors, payments, clicks or AI visits behind the metric stay below it
--   webhook_url   optional; signed with `secret` (HMAC-SHA256), which the API shows once
--   channels      1 = also send through every notification channel that covers the site
--   push          1 = also push to the iPhone app
--   crossed       JSON array of what is over the line now ("*" for the site, else page paths): the dedupe state
--   deliveries    JSON array of the last 20 deliveries, newest first
-- No index beyond the primary key: a deployment has at most 50 rules and the cron reads them all. A new rule costs 2
-- rows written (the row and its key), a change or a delete 1. The delivery log and the dedupe state go in the same
-- row, so a rule that fires, or goes back over its line, costs 1 row written too.
CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  path TEXT,
  comparison TEXT NOT NULL,
  threshold REAL NOT NULL,
  win TEXT NOT NULL,
  min_volume INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  secret TEXT,
  channels INTEGER NOT NULL DEFAULT 0,
  push INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  crossed TEXT NOT NULL DEFAULT '[]',
  deliveries TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
