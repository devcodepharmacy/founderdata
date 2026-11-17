-- "Daily numbers" sent marker (src/worker/numbers-digest.ts). One row per channel and UTC day: written when a send is
-- claimed, so a second trigger at 07:00 (the old daily cron next to the 5-minute tick) skips the channel, and set to
-- sent = 1 when the channel accepted the message. A row left at sent = 0 is retried on the hourly ticks of that day.
-- The 03:17 cleanup deletes rows older than 3 days.
--   tried_at   ms timestamp of the last attempt
CREATE TABLE numbers_sent (
  channel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  tried_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, day)
) WITHOUT ROWID;
