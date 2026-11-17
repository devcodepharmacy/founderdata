-- Alert rules, round 5 (src/worker/alert-rules.ts, docs/API.md "Alert rules", docs/GUIDE.md "Threshold alerts").
--   check_every   1h: every run of the hourly cron checks the rule. 1d: only the 07:00 UTC run. Rules from before
--                 this migration keep 1d, as they ran; a new rule gets 1h unless it says otherwise.
--   actor         note_verdict only: fire for changes by this actor, NULL for any actor
--   change_kind   note_verdict only: fire for changes of this kind (pricing, copy, seo ...), NULL for any kind
-- Other changes need no column:
--   site_id '*'   a portfolio rule: it watches every site, also sites added later, and fires per site
--   metric        adds note_verdict (a change's 7-day verdict turns worse), page_decay (a page enters the SEO tab's
--                 Decaying pages), asa_spend and asa_roas (Apple Search Ads)
--   comparison    adds rises_above
--   win           adds 28d, for page_google_clicks and page_decay
--   crossed       for note_verdict: the ids of the notes already judged, so each note fires at most once
-- ALTER TABLE ... ADD COLUMN with a constant default rewrites no row.
ALTER TABLE alert_rules ADD COLUMN check_every TEXT NOT NULL DEFAULT '1d';
ALTER TABLE alert_rules ADD COLUMN actor TEXT;
ALTER TABLE alert_rules ADD COLUMN change_kind TEXT;
