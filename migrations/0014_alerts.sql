-- Alert channels (src/worker/alerts.ts, docs/GUIDE.md "Alerts and weekly report"). One deployment has one dashboard
-- owner, so channels belong to the deployment, not to a site. Sending an alert writes nothing: a channel row changes
-- only when the owner edits it in the dashboard.
CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- slack, discord, telegram, webhook or email
  name TEXT NOT NULL,
  target TEXT NOT NULL,        -- the webhook URL, the Telegram chat id or the email address
  secret TEXT,                 -- the Telegram bot token, NULL for the other kinds
  alerts TEXT NOT NULL,        -- JSON of the alert switches: purchase, renewal, refund, trial, daily, cap, weekly
  sites TEXT,                  -- JSON array of the site ids it covers, NULL for every site
  created_at INTEGER NOT NULL
);
