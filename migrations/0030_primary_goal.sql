-- The primary goal of a site (src/worker/primary-goal.ts, docs/GUIDE.md "Primary goal"): one goal name, such as
-- newsletter_signup, that Home, GET /api/v1/portfolio and the weekly report count for the site. A site without
-- revenue shows it as its headline number.
--   primary_goal         the goal's name as the tracker sends it; NULL means none picked
--   primary_goal_label   how the number reads, such as "Signups"; NULL reads the name ("Newsletter signup")
-- Setting it rewrites the site row: 1 row written.
ALTER TABLE sites ADD COLUMN primary_goal TEXT;
ALTER TABLE sites ADD COLUMN primary_goal_label TEXT;
