-- What kind of product a site is (src/worker/product-type.ts, docs/GUIDE.md "Product types"): website, app, extension
-- or newsletter. The type picks the numbers a site leads with on its Overview, on Home, in the portfolio and in the
-- weekly report: an extension leads with installs, weekly active users and uninstalls, a newsletter with subscribers,
-- new subscribers, unsubscribes and opens. Both count goal events the event API already takes.
--   product_type   NULL means automatic: app when the site has a bundle id, else website.
-- Setting it rewrites the site row: 1 row written.
ALTER TABLE sites ADD COLUMN product_type TEXT;
