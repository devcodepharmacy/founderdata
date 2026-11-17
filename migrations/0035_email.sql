-- Email delivery numbers per site from Resend webhooks (src/worker/email.ts, docs/GUIDE.md "Email (Resend)",
-- docs/API.md "GET /api/v1/email"). One webhook per Resend account serves every site: an event belongs to the site
-- whose domain the sender's address is on. No recipient address and no subject is stored.
--
-- email_messages: one row per email Resend sent, kept 30 days for dedupe, then deleted by the daily cron.
--   id       Resend's email id
--   day      the day the email was created, in the site's timezone: every event of the email counts on that day
--   sender   the From address without its display name, lowercased
--   tag      the value of the email's `category` tag, '' without one
--   seen     bit mask of the event types counted for this email (sent 1, delivered 2, delivery_delayed 4, bounced 8,
--            complained 16, opened 32, clicked 64). A retry of an event, a second open or a second click finds its
--            bit set and writes nothing.
--   ts       when the email was created (ms), for the 30-day cleanup
-- WITHOUT ROWID with no other index: a new row costs 1 row written, a new event type for a known email 1.
CREATE TABLE email_messages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
) WITHOUT ROWID;

-- email_daily: per site, day, sender and tag, how many emails had each event at least once. Kept with the site.
-- Each counted event adds 1 row written here (an upsert), so a counted event costs 2 rows in total.
CREATE TABLE email_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  delayed INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 0,
  complained INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, sender, tag)
) WITHOUT ROWID;
