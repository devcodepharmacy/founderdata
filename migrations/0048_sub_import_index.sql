-- Imported subscriptions found without scanning the table (src/worker/sub-import.ts): the summary under the
-- Subscriptions tab, the delete and the month check all start from import_id. The index holds no row for a site that
-- never imported.
-- import_source: chartmogul or revenuecat, the import that made or extended the row. provider says who bills it
-- (stripe for a Stripe subscription), so live events and Stripe checks treat an imported row like any other.
ALTER TABLE subscriptions ADD COLUMN import_source TEXT;
CREATE INDEX subscriptions_import ON subscriptions (site_id, import_id) WHERE import_id IS NOT NULL;
UPDATE subscriptions SET import_source = (SELECT source FROM sub_imports WHERE sub_imports.id = subscriptions.import_id) WHERE import_id IS NOT NULL;
UPDATE subscriptions SET provider = 'stripe' WHERE import_id IS NOT NULL AND provider = 'chartmogul' AND id LIKE 'sub\_%' ESCAPE '\';

-- held: subscriptions this import left alone because another import already holds them, so the screen can say so.
ALTER TABLE sub_imports ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
