-- AI visibility: a prompt runner on top of the AI answer history, and AI crawler hits
-- (src/worker/ai-visibility.ts, src/worker/ai-crawlers.ts, docs/AI-VISIBILITY.md).
--
-- ai_answers gets four columns that only the runner fills. Rows an agent pushes keep NULL there.
--   engine         openai, anthropic or gemini; NULL for a row an agent pushed
--   mentions       JSON [{name, kind: brand or competitor, position, count}] for every tracked name the answer contains
--   cited_domains  JSON array of the hosts of cited_urls, without www., each once
--   cost_micro     estimated cost of the check in millionths of a US dollar
ALTER TABLE ai_answers ADD COLUMN engine TEXT;
ALTER TABLE ai_answers ADD COLUMN mentions TEXT;
ALTER TABLE ai_answers ADD COLUMN cited_domains TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_answers ADD COLUMN cost_micro INTEGER;

-- ai_prompts: the prompts the runner asks. The id is a hash of the lowercased text, so a prompt saved twice is one row.
-- 1 row written per prompt.
CREATE TABLE ai_prompts (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;

-- ai_settings: one row per site. 1 row written per save.
--   brands, competitors  JSON arrays of names; empty brands means the site's name
--   engines              JSON { openai: { enabled, model }, anthropic: {...}, gemini: {...} }
--   monthly_cap_micro    stop running when the month's estimated spend reaches it, in millionths of a US dollar
--   errors               JSON { engine: { message, at } } of each engine's last failed run, cleared by the next good one
CREATE TABLE ai_settings (
  site_id TEXT NOT NULL PRIMARY KEY,
  brands TEXT NOT NULL DEFAULT '[]',
  competitors TEXT NOT NULL DEFAULT '[]',
  engines TEXT NOT NULL DEFAULT '{}',
  monthly_cap_micro INTEGER NOT NULL DEFAULT 20000000,
  errors TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ai_spend: estimated spend and checks per site, UTC month (YYYY-MM) and engine. The runner adds to it once per site
-- and engine in each hourly run, not once per check.
CREATE TABLE ai_spend (
  site_id TEXT NOT NULL,
  month TEXT NOT NULL,
  engine TEXT NOT NULL,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, month, engine)
) WITHOUT ROWID;

-- ai_crawler_hits: hits of AI crawlers (GPTBot, ClaudeBot, PerplexityBot, ...) that a site's server forwards. One row
-- per site, UTC day, bot, path and status, with a counter, not one row per hit. A request with N distinct
-- combinations writes N rows. Past 2,000 rows a site and day, new combinations count under the path "(other)".
CREATE TABLE ai_crawler_hits (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bot TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, bot, path, status)
) WITHOUT ROWID;
