-- Meta ads (docs/GUIDE.md "Meta ads"): ad clicks on sessions, the Marketing API import (src/worker/meta.ts), the per-site
-- settings and the Conversions API log (src/worker/meta-capi.ts). Every table is empty until the owner sets up Meta.

-- The ad click a session landed with (src/worker/collect.ts metaClick):
--   fbclid     Meta's click id, from ad and organic link clicks alike; with fbclid_at it rebuilds the fbc value Meta asks for
--   ad_id      the Meta ad id from the ad's URL parameters (ad_id={{ad.id}}); only an ad click has one
--   click_ua   the user agent of that click, kept for the Conversions API only, and only on sessions with a click
--   consent    1 when the visitor agreed to marketing use, the consent the Conversions API needs: founderdata('marketing', true)
--              or data-marketing="on" (src/worker/meta-capi.ts). Analytics cookies alone do not set it
-- No new row: the columns ride on the session insert.
ALTER TABLE sessions ADD COLUMN fbclid TEXT;
ALTER TABLE sessions ADD COLUMN fbclid_at INTEGER;
ALTER TABLE sessions ADD COLUMN ad_id TEXT;
ALTER TABLE sessions ADD COLUMN click_ua TEXT;
ALTER TABLE sessions ADD COLUMN consent INTEGER NOT NULL DEFAULT 0;

-- 1 when the site's Conversions API sends every web purchase (meta_settings.capi_mode = 'all'): then every session with
-- marketing consent keeps click_ua, since Meta needs the browser's user agent for a website event. Kept in step by
-- PUT /meta/settings.
ALTER TABLE sites ADD COLUMN keep_ua INTEGER NOT NULL DEFAULT 0;

-- One row per site that runs Meta ads. The access token is a Worker secret (META_ACCESS_TOKEN), never a column.
--   ad_account_id   the ad account's number, without "act_"
--   campaign_filter only campaigns whose name contains this text belong to the site (one account, several products)
--   pixel_id        the dataset (pixel) id the Conversions API sends to
--   capi_mode       off, clicks (buyers who came through a Meta click) or all (every web purchase)
--   capi_consent    1 (the default) = only visitors whose visit carried marketing consent; Meta asks not to send people who did not
--   capi_consent_off_at  when the owner turned capi_consent off, acknowledging it (null while on)
--   target_cpa      optional: what a customer may cost, minor units of the site currency
--   breakeven_roas  optional: revenue over spend at which an ad pays for itself after VAT, cost of goods and fees
--   checkout_goal   optional: the goal that marks a checkout start; unset = goals whose name contains "checkout"
--   capi_test_code  Meta's test event code, sent only with the test button's FounderDataTest event
--   goal_events     JSON object, goal name -> Meta standard event, sent for visits from an ad click
--   capi_since      when the Conversions API was turned on: earlier payments are never sent
--   goal_cursor     the last events.id the goal sender looked at
CREATE TABLE meta_settings (
  site_id TEXT PRIMARY KEY,
  ad_account_id TEXT,
  campaign_filter TEXT,
  pixel_id TEXT,
  capi_mode TEXT NOT NULL DEFAULT 'off',
  capi_consent INTEGER NOT NULL DEFAULT 1,
  capi_consent_off_at INTEGER,
  capi_test_code TEXT,
  goal_events TEXT,
  target_cpa INTEGER,
  breakeven_roas REAL,
  checkout_goal TEXT,
  capi_since INTEGER,
  goal_cursor INTEGER NOT NULL DEFAULT 0,
  capi_last_at INTEGER,
  capi_last_error TEXT,
  capi_last_error_at INTEGER,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per ad account the import reads: its name, currency, timezone (Meta's days are the account's days) and status
-- (1 active, 2 disabled, 3 unsettled, 7 pending review, 9 in grace period...), and the last import. failures counts runs
-- that failed in a row; a passing problem shows only from the second, a refused token at once.
CREATE TABLE meta_accounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  currency TEXT,
  timezone TEXT,
  status INTEGER,
  imported_at INTEGER,
  last_day TEXT,
  error TEXT,
  error_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  restated_on TEXT,
  restated_long_on TEXT,
  backfill_next TEXT
) WITHOUT ROWID;

-- Campaigns, ad sets and ads by id. parent: the campaign of an ad set, the ad set of an ad. freq7 and reach7: frequency
-- and reach of an ad or ad set over the 7 days up to yesterday, from the daily run. goal: the ad set's optimization goal
-- (OFFSITE_CONVERSIONS, LINK_CLICKS...) or the campaign's objective. budget: daily (budget_kind 'daily') or lifetime
-- budget in minor units of the account currency. learning: the ad set's learning phase (LEARNING, SUCCESS, FAIL). Thumbnails are not stored: Meta signs their
-- addresses and they expire, so the dashboard asks Meta for them (src/worker/meta.ts adThumbnails).
CREATE TABLE meta_objects (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT,
  parent TEXT,
  status TEXT,
  goal TEXT,
  budget INTEGER,
  budget_kind TEXT,
  learning TEXT,
  freq7 REAL,
  reach7 INTEGER,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

-- Meta's numbers per ad and day (the account's day). spend and purchase_value in millionths of the account currency.
-- clicks are link clicks. purchases, purchase_value, leads and checkouts are what Meta attributes with the account's
-- attribution setting. video_3s: 3-second video plays; thruplays: plays to 15 seconds or the end.
CREATE TABLE meta_daily (
  ad_id TEXT NOT NULL,
  day TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT,
  adset_id TEXT,
  spend INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  reach INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  purchase_value INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  checkouts INTEGER NOT NULL DEFAULT 0,
  video_3s INTEGER NOT NULL DEFAULT 0,
  thruplays INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_id, day)
) WITHOUT ROWID;
CREATE INDEX meta_daily_account_day ON meta_daily (account_id, day);

-- What the Conversions API sent, one row per event: for the status in Settings and so no event goes twice.
-- status: sent, failed or skipped (with the reason in error). A failed event goes again after 15 minutes: up to 5 times for
-- an error in the event itself, and until it is 7 days old for a problem on Meta's side or the token (retry = 1).
-- Pruned after 30 days.
CREATE TABLE meta_capi_log (
  site_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  retry INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, event_name, event_id)
) WITHOUT ROWID;
CREATE INDEX meta_capi_log_sent ON meta_capi_log (site_id, sent_at);
