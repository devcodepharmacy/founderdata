-- Live Activity push tokens per phone (docs/MOBILE-API.md section 2, src/worker/live-activity.ts).
--   live_start_token   the push-to-start token of the activity type: the 08:00 run starts the day's activity with it.
--   live_update_token  the token of the running activity: a payment updates it, at most once a minute.
--   live_env           sandbox or production, for both tokens.
--   live_topic         the app's bundle id; the Worker sends to <live_topic>.push-type.liveactivity.
--   live_pushed_at     ms of the last update push, for the once-a-minute throttle.
-- Registering a token writes 1 row, the same token again none. A token APNs rejects for good is cleared.
ALTER TABLE devices ADD COLUMN live_start_token TEXT;
ALTER TABLE devices ADD COLUMN live_update_token TEXT;
ALTER TABLE devices ADD COLUMN live_env TEXT;
ALTER TABLE devices ADD COLUMN live_topic TEXT;
ALTER TABLE devices ADD COLUMN live_pushed_at INTEGER;
