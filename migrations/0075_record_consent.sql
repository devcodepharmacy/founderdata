-- Record visits can wait for consent (docs/GUIDE.md, "People and recordings (Pro)"; docs/PRIVACY.md, "Recordings").
--   record_consent  1 = the tracker records a visit only after the visitor consented to cookies: data-cookies="on" on
--                   the script tag, or founderdata('consent', true) from the site's banner. Remember visitors does not
--                   count as consent. Off by default.
ALTER TABLE sites ADD COLUMN record_consent INTEGER NOT NULL DEFAULT 0;
