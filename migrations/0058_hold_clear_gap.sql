-- Hold clearing is rate limited (docs/GUIDE.md, "Setup checklist" and docs/SEO.md, "Keyword research and rank tracking").
--
-- Adding keywords ends the hold on a site whose last post failed, so the new keyword is tried at the next tick. Google
-- ranks already keep rank_settings.last_error_at; hosted App Store ranks had no time, so this adds one. A hold younger than
-- 5 minutes stays, which stops a script that adds one keyword a minute from forcing a retry at every tick.
-- No rows are written by this migration: existing holds have no time and clear on the next keyword add, as before.
ALTER TABLE aso_settings ADD COLUMN hosted_error_at INTEGER;
