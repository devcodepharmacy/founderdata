-- Which post paid: the handle that wrote each post, so a post keeps its own link after the site's handle changes
-- (src/worker/x-posts.ts). NULL on rows stored before this migration and on posts added by hand without an x.com address:
-- those link through x.com/i/status/<id>, which X resolves to the author. No row is rewritten.
ALTER TABLE x_posts ADD COLUMN handle TEXT;
