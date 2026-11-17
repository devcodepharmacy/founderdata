-- Annotations on chart notes (src/worker/notes.ts, docs/API.md "POST /api/v1/notes"): who made a change, what kind of
-- change, where, and what it was before and after, so an agent can log its own changes and read their impact.
-- Every column is optional; notes from before this migration keep NULL in all of them.
--   actor            who made the change: "landing-agent", "pascal"
--   change_kind      copy, pricing, aso, seo, ads, release, launch or other (the API calls it `kind`; the column
--                    `kind` already says where the note came from: manual, api or version)
--   target           what changed: "/pricing", "keyword:habit tracker"
--   before_text, after_text   the old and the new value, short text
--   idempotency_key  one per site: a POST with a key the site already has returns that note and stores nothing.
-- A note with an idempotency key costs one row more (the unique index): 4 rows written instead of 3.
ALTER TABLE notes ADD COLUMN actor TEXT;
ALTER TABLE notes ADD COLUMN change_kind TEXT;
ALTER TABLE notes ADD COLUMN target TEXT;
ALTER TABLE notes ADD COLUMN before_text TEXT;
ALTER TABLE notes ADD COLUMN after_text TEXT;
ALTER TABLE notes ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX notes_site_idempotency ON notes (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
