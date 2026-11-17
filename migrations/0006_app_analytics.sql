-- Session properties from RevtrailKit API v2 (user_state, onboarding_variant, exp_<name>, ...), as a JSON object
-- of strings, at most 10 keys. A column, not a table: it is written by the session INSERT or the per-batch
-- session UPDATE that ingestion runs anyway, so it adds no D1 rows; a table would add a row plus index entries
-- per property. No index: the App panels read it per session already selected by (site_id, started_at).
ALTER TABLE sessions ADD COLUMN props TEXT;

-- 1 = the install id is kept on the device (the app called Revtrail.setConsent(true); the SDK sends ctx.consent).
-- Only these installs can come back under the same id, so retention covers them alone.
ALTER TABLE visitors ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
