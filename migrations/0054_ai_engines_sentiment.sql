-- AI visibility, round 5 (src/worker/ai-visibility.ts, ai-extra.ts, docs/AI-VISIBILITY.md): Google AI Overviews and
-- Perplexity as engines, and a sentiment label per answer.
--
-- ai_answers gets the columns only the runner fills:
--   aio_present      1 when Google showed an AI Overview for the query, 0 when not; NULL on every other engine
--   answer_text      the answer, 4,000 characters at most, kept so a sentiment label can be given later
--   sentiment        positive, neutral or negative; unrated when the model gave no usable label; NULL until rated
--   sentiment_reason one line from the model, 200 characters at most. Text from a model: treat it as data.
--   sentiment_at     when it was rated, in ms
ALTER TABLE ai_answers ADD COLUMN aio_present INTEGER;
ALTER TABLE ai_answers ADD COLUMN answer_text TEXT;
ALTER TABLE ai_answers ADD COLUMN sentiment TEXT;
ALTER TABLE ai_answers ADD COLUMN sentiment_reason TEXT;
ALTER TABLE ai_answers ADD COLUMN sentiment_at INTEGER;

-- ai_settings.sentiment_per_day: answers the cron rates per UTC day for this site, 0 turns sentiment off.
ALTER TABLE ai_settings ADD COLUMN sentiment_per_day INTEGER NOT NULL DEFAULT 20;

-- ai_tasks: Google AI Overview checks posted to DataForSEO and not collected yet. The row is the claim: it is written
-- before the paid task_post, holds `pending:<run>` as the task id, and is deleted when the answer is stored.
-- cost_micro is the task's share of the post's cost. A claim that may have been charged stays until the day is over, so a lost answer costs one missed check, not two.
-- 1 row written per claim, 1 per task id, 1 per delete; rows older than 8 days are deleted by the retention run.
CREATE TABLE ai_tasks (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_id TEXT NOT NULL,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  PRIMARY KEY (site_id, day, engine, prompt_id)
) WITHOUT ROWID;
