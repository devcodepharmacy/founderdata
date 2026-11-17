-- The live globe (GET /api/live, src/worker/live.ts, docs/MOBILE-API.md section 9).
--   sessions.lat, sessions.lon  the visit's coarse location from Cloudflare's IP lookup (or the trusted Vercel headers),
--                               rounded to one decimal, about 11 km: no finer than the city already stored. Written by
--                               the same insert as the visit, so a visit costs no extra row. NULL for older visits and
--                               when the lookup has none; the client then places the visit at its country.
--   payments_visitor            "has paid before" for each visitor online, one index probe each instead of a scan of
--                               every payment on each poll. Writes 1 more row for a payment credited to a visitor; refunds are not in it.
--   subscriptions_trial         trials started in the last hour without a scan of every subscription. Writes 1 more row
--                               when a subscription with a trial is created or its trial start changes.
ALTER TABLE sessions ADD COLUMN lat REAL;
ALTER TABLE sessions ADD COLUMN lon REAL;
CREATE INDEX payments_visitor ON payments (site_id, visitor_id) WHERE visitor_id IS NOT NULL AND kind = 'payment';
CREATE INDEX subscriptions_trial ON subscriptions (site_id, trial_start) WHERE trial_start IS NOT NULL;
