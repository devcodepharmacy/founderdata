-- Reviews of chart notes (src/worker/notes.ts, docs/API.md "POST /api/v1/notes/<id>/review"): an agent logs a change
-- as a note, reads its impact once the window has closed (GET /api/v1/notes?due=true) and records what it did about it.
-- A note is reviewed once; notes from before this migration are unreviewed.
--   reviewed_at      ms, when the review came in; NULL means not reviewed yet
--   review_outcome   kept, reverted or iterated
--   review_comment   optional short text, 280 characters at most
-- No index: the due list reads a site's notes by time (notes_site_time) and checks reviewed_at on those rows. So a
-- review costs 1 row written.
ALTER TABLE notes ADD COLUMN reviewed_at INTEGER;
ALTER TABLE notes ADD COLUMN review_outcome TEXT;
ALTER TABLE notes ADD COLUMN review_comment TEXT;
