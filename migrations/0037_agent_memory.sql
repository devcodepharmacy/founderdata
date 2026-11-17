-- What agents record, not only read (src/worker/agent-memory.ts, docs/API.md "Research log" and "AI answer checks").
--
-- research: the research log, one row per finding an agent wants the next agent to know: keyword research, competitor
-- notes, a decision, "checked the SERP for X on day Y, it cost Z". Agents read it before they buy or collect data
-- again. The primary key is the listing order, so a row costs 1 row written; an idempotency key adds 1 (its index).
--   created_at       ms
--   kind             keywords, competitors, serp, backlinks, ai_answers, aso, audit, decision, purchase or other
--   title            one line, 200 characters at most
--   body             up to 4,000 characters
--   urls, tags       JSON arrays (20 URLs, 10 tags at most)
--   cost_minor       what the data cost, in minor units of cost_currency; NULL means free or not known
--   valid_until      ms after which the finding is stale and worth checking again; NULL means no end
--   idempotency_key  one per site: a second POST with the same key stores nothing and answers the first row
CREATE TABLE research (
  site_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  urls TEXT NOT NULL DEFAULT '[]',
  cost_minor INTEGER,
  cost_currency TEXT,
  actor TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  valid_until INTEGER,
  idempotency_key TEXT,
  PRIMARY KEY (site_id, created_at, id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX research_site_idempotency ON research (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ai_answers: one row per prompt, AI surface (ChatGPT, Perplexity, Google AI Mode, ...) and day, so the AI answer
-- panel keeps its history instead of living in the replaced SEO meta snapshot. A second POST for the same prompt,
-- surface and day replaces the row. 1 row written per answer, new or replaced.
--   day              YYYY-MM-DD in UTC; checked_at is the time of the check in ms
--   measured         1 when the check ran, 0 when it could not (sign-in wall, broken browser); reason says why
--   mentioned        1 or 0 when measured, else NULL: does the answer name the product
--   rank_position    the product's place in the answer's list, NULL when not listed or not measured
--   cited_urls, competitors, factual_errors   JSON arrays of text
--   domain_cited     1 when a cited URL is on the site's domain, 0 when not, NULL when not measured
--   signed_in        1, 0 or NULL (not measured); country and language NULL when not measured
--   excerpt          the start of the answer, 1,000 characters at most
CREATE TABLE ai_answers (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  prompt TEXT NOT NULL,
  prompt_id TEXT,
  checked_at INTEGER NOT NULL,
  measured INTEGER NOT NULL,
  mentioned INTEGER,
  rank_position INTEGER,
  cited_urls TEXT NOT NULL DEFAULT '[]',
  domain_cited INTEGER,
  competitors TEXT NOT NULL DEFAULT '[]',
  factual_errors TEXT NOT NULL DEFAULT '[]',
  model_label TEXT,
  signed_in INTEGER,
  country TEXT,
  language TEXT,
  excerpt TEXT,
  reason TEXT,
  actor TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, surface, prompt)
) WITHOUT ROWID;
