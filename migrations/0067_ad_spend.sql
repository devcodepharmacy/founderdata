-- Ad spend from every channel (src/worker/spend.ts, src/worker/paid-stats.ts, docs/API.md "Ad spend").
--
-- ad_spend holds what has no native import: Google Ads, Microsoft Ads, TikTok, Reddit, LinkedIn, X, a newsletter
-- sponsorship. It arrives through POST /api/v1/spend (a key with spend:write, the Google Ads Script in docs/GUIDE.md) or a
-- CSV upload. One row per site, day, channel, account, campaign, ad group and ad; an id the sender does not have is ''.
--   day           YYYY-MM-DD as the sender counts it. The guide asks for the site's timezone.
--   channel       google_ads, microsoft_ads, tiktok_ads, x_ads, linkedin_ads, reddit_ads, snapchat_ads, pinterest_ads,
--                 meta, apple_search_ads, or the sender's own name (newsletter, podcast): lowercase letters, digits, _
--   spend         millionths of `currency`, like meta_daily and asa_daily. The API takes minor units or micros.
--   impressions, clicks, installs, conversions, conversion_value: the platform's numbers, null when not sent.
--                 conversion_value is in millionths of `currency`.
--   origin        api or csv
-- A row is written only when a value changed (ON CONFLICT ... WHERE), so a script that resends the last days costs 0
-- rows for the days that did not move. No secondary index: each row costs 1 row written.
CREATE TABLE ad_spend (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  adgroup_id TEXT NOT NULL DEFAULT '',
  ad_id TEXT NOT NULL DEFAULT '',
  campaign_name TEXT,
  spend INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  impressions INTEGER,
  clicks INTEGER,
  installs INTEGER,
  conversions REAL,
  conversion_value INTEGER,
  origin TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, channel, account_id, campaign_id, adgroup_id, ad_id)
) WITHOUT ROWID;

-- Every channel's spend in one shape, read by the paid report (src/worker/paid-stats.ts). Meta and Apple Search Ads
-- stay in their own tables and join in here, so their rows are never written twice.
--   meta              meta_daily per ad and day (the ad account's day), for each site whose Meta settings name the
--                     account, limited to campaigns whose name contains the site's campaign filter
--   apple_search_ads  asa_daily campaign rows (keyword ''; Apple's UTC day) of campaigns that promote the site's app:
--                     its App Store id (asc_app_id, app_store_id) or an app row with its bundle id
-- spend and conversion_value are millionths of `currency` in every row.
CREATE VIEW spend_daily AS
SELECT a.site_id, a.day, a.channel, a.account_id, a.campaign_id, a.campaign_name, a.adgroup_id, a.ad_id, a.spend, a.currency,
       a.impressions, a.clicks, a.installs, a.conversions, a.conversion_value, a.origin
FROM ad_spend a
UNION ALL
SELECT ms.site_id, d.day, 'meta', d.account_id, COALESCE(d.campaign_id, ''), c.name, COALESCE(d.adset_id, ''), d.ad_id, d.spend,
       COALESCE(acc.currency, st.currency), d.impressions, d.clicks, NULL, d.purchases, d.purchase_value, 'meta'
FROM meta_settings ms
JOIN sites st ON st.id = ms.site_id
JOIN meta_daily d ON d.account_id = ms.ad_account_id
LEFT JOIN meta_accounts acc ON acc.id = d.account_id
LEFT JOIN meta_objects c ON c.kind = 'campaign' AND c.id = d.campaign_id
WHERE ms.ad_account_id IS NOT NULL AND ms.ad_account_id != ''
  AND (TRIM(COALESCE(ms.campaign_filter, '')) = ''
       OR d.campaign_id IN (SELECT o.id FROM meta_objects o WHERE o.kind = 'campaign' AND o.account_id = d.account_id
                              AND instr(lower(o.name), lower(TRIM(ms.campaign_filter))) > 0))
UNION ALL
SELECT st.id, d.day, 'apple_search_ads', COALESCE(c.org, ''), d.campaign, c.name, '', '', d.spend, COALESCE(d.currency, st.currency),
       d.impressions, d.taps, d.installs, NULL, NULL, 'asa'
FROM sites st
JOIN asa_names c ON c.kind = 'campaign'
  AND (c.parent IN (st.asc_app_id, st.app_store_id)
       OR c.parent IN (SELECT n.id FROM asa_names n WHERE n.kind = 'app' AND n.parent = st.app_bundle_id))
JOIN asa_daily d ON d.campaign = c.id AND d.keyword = '';
