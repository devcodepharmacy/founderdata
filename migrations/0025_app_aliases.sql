-- Without consent the iOS SDK makes a new install id on every launch. So that one person opening the app twenty
-- times a day counts once, the server groups those launches by a daily key, the way the web tracker counts
-- cookieless visitors (src/worker/app.ts, resolveLaunch; docs/APP-API.md section 3). Each row points one id at
-- the visitor it belongs to:
--   day_<hash>   the daily key HMAC(daily salt, site | IP | user agent | device | OS | locale), first launch wins
--   <install id> a later launch of that visitor, so its later batches and its appAccountToken find the visitor
--   <session id> an SDK session that continues the visitor's session from the last 30 minutes (session_id)
-- The daily cron deletes rows after 30 days (src/worker/retention.ts).
CREATE TABLE app_aliases (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
