-- Setup checklist (docs/GUIDE.md, "Setup checklist").
--
-- location_errors: a DataForSEO location or language code the API refused, kept per site and place so the dashboard shows
-- it on that country's row and in the checklist. `source` is 'google' (place = the site's location code) or 'aso'
-- (place = the App Store country). The cron writes a row when a refused task names a location or language, only when
-- the message changed or is older than a day, and deletes it when a check for the same place is accepted or the site's
-- location settings change. Rows written: 1 per refused place per day.
CREATE TABLE location_errors (
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,
  place TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (site_id, source, place)
) WITHOUT ROWID;
