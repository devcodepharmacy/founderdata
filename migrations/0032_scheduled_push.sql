-- Scheduled pushes and the renewal threshold, per phone (docs/MOBILE-API.md section 3, src/worker/scheduled-push.ts).
-- digest_daily: the 08:00 "Since yesterday" push. digest_weekly: the Monday 08:00 weekly report push. Both start on.
-- renewal_min: renewals below this amount push no alert, in major units of renewal_min_currency. NULL means the
-- default, 5 in the first site's currency; 0 pushes every renewal.
ALTER TABLE devices ADD COLUMN digest_daily INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN digest_weekly INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN renewal_min REAL;
ALTER TABLE devices ADD COLUMN renewal_min_currency TEXT;

-- The last day each scheduled push went out, so the hourly cron sends it once per day: one row per kind
-- ('daily', 'weekly'), `day` is YYYY-MM-DD in the reporting timezone.
CREATE TABLE scheduled_pushes (
  kind TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  sent_at INTEGER NOT NULL
) WITHOUT ROWID;
