-- Apple Search Ads import (src/worker/asa.ts, docs/GUIDE.md "Apple Search Ads").
-- Names of what the AdServices token only gives as ids, from the Apple Ads Platform API:
--   app       id = adamId, name = app name, parent = bundle id (from Apple's public lookup)
--   campaign  id = campaignId, parent = adamId of the promoted app
--   adgroup   id = adGroupId, parent = campaignId
--   keyword   id = keywordId, name = keyword text, parent = adGroupId
-- org is the Apple Ads ad account. Ids are unique within one, and in practice across them.
CREATE TABLE asa_names (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  parent TEXT,
  org TEXT,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

-- Apple's daily numbers, one row per UTC day and campaign (keyword = '') or keyword. spend is in millionths of the
-- ad account's currency. installs is Apple's total (tap and view). Days with no impressions, taps or spend are not stored.
CREATE TABLE asa_daily (
  day TEXT NOT NULL,
  campaign TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  adgroup TEXT NOT NULL DEFAULT '',
  spend INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  taps INTEGER NOT NULL DEFAULT 0,
  installs INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign, keyword)
) WITHOUT ROWID;

-- The last import, one row: when it ran, the last day it covered and the error it stopped on, if any.
CREATE TABLE asa_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at INTEGER NOT NULL,
  last_day TEXT,
  error TEXT
);
