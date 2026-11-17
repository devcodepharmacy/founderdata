-- Verdicts by kind of change (src/worker/verdicts.ts, docs/API.md "The verdict"). Each column rides on the note's own
-- row, so a note still costs 3 rows written (4 with an idempotency key). Notes from before this migration keep NULL in
-- all four and keep the visit rule with a 7-day window.
--   metric       what the verdict judges: visits (the visit rule), keyword_rank, search_clicks,
--                google_rank, ai_mention_rate, ai_citation_rate, cpa, roas, paywall_conversion or trial_rate. Set when
--                the note is stored, from the kind and target unless the request names one.
--   window_days  days on each side of the note, 1 to 28: 28 for search, Google rank and AI notes, 7 for the rest
--   group_key    notes with the same key are one change (a page copied to six locales): counted once, reviewed together
--   ends_at      ms, when an outage ended. Only notes of kind outage have it; they mark a gap in the data.
ALTER TABLE notes ADD COLUMN metric TEXT;
ALTER TABLE notes ADD COLUMN window_days INTEGER;
ALTER TABLE notes ADD COLUMN group_key TEXT;
ALTER TABLE notes ADD COLUMN ends_at INTEGER;
