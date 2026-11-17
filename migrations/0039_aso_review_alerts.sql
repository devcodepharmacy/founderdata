-- Review alerts per app (src/worker/aso-alerts.ts, docs/ASO.md "Review alerts"). A new written review at or below
-- review_alert_stars alerts the channels and the phone, unless review_alert is 0. No new rows: the settings row an
-- app already has holds both. An app without a settings row uses the defaults, on at 3 stars.
ALTER TABLE aso_settings ADD COLUMN review_alert INTEGER NOT NULL DEFAULT 1;
ALTER TABLE aso_settings ADD COLUMN review_alert_stars INTEGER NOT NULL DEFAULT 3;
