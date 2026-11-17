-- The App Store id of a site's app, entered by the owner (src/worker/index.ts, docs/GUIDE.md "Apple Search Ads").
-- The App Store sales import finds the same id on its own (sites.asc_app_id); this column is for a deployment
-- without that import. Apple Search Ads campaigns and ASO match an app on either id.
ALTER TABLE sites ADD COLUMN app_store_id TEXT;

-- Apps that Apple Search Ads campaigns promote and no site is tied to, as JSON [{ "id": "...", "name": "..." }],
-- or NULL when every promoted app has a site. Written with the status row on every import.
ALTER TABLE asa_status ADD COLUMN unmatched TEXT;
