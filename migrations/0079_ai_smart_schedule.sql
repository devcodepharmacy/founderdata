-- The smart AI check schedule (docs/AI-VISIBILITY.md "How checks are scheduled").
--
-- ai_answers.sample: a runner check can be asked more than once on one UTC day. A new prompt gets a baseline of 3 answers
-- on its first day, stored as samples 0, 1 and 2. Rows an agent pushes and every older row are sample 0. The key gains the
-- column, so the table is rebuilt: SQLite can't change a primary key in place. The copy writes each existing row once.
CREATE TABLE ai_answers_new (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  prompt TEXT NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0,
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
  engine TEXT,
  mentions TEXT,
  cited_domains TEXT NOT NULL DEFAULT '[]',
  cost_micro INTEGER,
  aio_present INTEGER,
  answer_text TEXT,
  sentiment TEXT,
  sentiment_reason TEXT,
  sentiment_at INTEGER,
  PRIMARY KEY (site_id, day, surface, prompt, sample)
) WITHOUT ROWID;

INSERT INTO ai_answers_new (site_id, day, surface, prompt, sample, prompt_id, checked_at, measured, mentioned, rank_position,
  cited_urls, domain_cited, competitors, factual_errors, model_label, signed_in, country, language, excerpt, reason, actor,
  updated_at, engine, mentions, cited_domains, cost_micro, aio_present, answer_text, sentiment, sentiment_reason, sentiment_at)
SELECT site_id, day, surface, prompt, 0, prompt_id, checked_at, measured, mentioned, rank_position,
  cited_urls, domain_cited, competitors, factual_errors, model_label, signed_in, country, language, excerpt, reason, actor,
  updated_at, engine, mentions, cited_domains, cost_micro, aio_present, answer_text, sentiment, sentiment_reason, sentiment_at
FROM ai_answers;

DROP TABLE ai_answers;
ALTER TABLE ai_answers_new RENAME TO ai_answers;

-- ai_claims: the claim is per sample too, so the 3 baseline answers of a prompt can be in flight at once. Claims live for
-- minutes, so the table is recreated empty.
DROP TABLE ai_claims;
CREATE TABLE ai_claims (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, engine, prompt_id, sample)
) WITHOUT ROWID;

-- ai_settings.schedule: 'smart' (the default) checks a prompt by how settled its answers are and paces the month's cap over
-- the days left; 'daily' asks every prompt once a day, as before.
ALTER TABLE ai_settings ADD COLUMN schedule TEXT NOT NULL DEFAULT 'smart';

-- ai_settings.done_day: the UTC day on which a run found no check left for the site (nothing due, or the day's share of
-- the cap spent), so the later ticks of that day skip the read of its answer history. Saving the settings or adding
-- prompts clears it.
ALTER TABLE ai_settings ADD COLUMN done_day TEXT;
