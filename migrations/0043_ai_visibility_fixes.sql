-- AI visibility fixes (src/worker/ai-visibility.ts, ai-crawlers.ts, retention.ts).
--
-- ai_spend.searches: search calls the runner made per site, month and engine. Gemini's 5,000 free grounded queries a
-- month are netted off with it, so the cap does not pause early.
ALTER TABLE ai_spend ADD COLUMN searches INTEGER NOT NULL DEFAULT 0;

-- ai_failures: checks that failed for their own reason (the engine refused or returned no text for this prompt), per
-- site, UTC day, engine and prompt. A prompt with 2 failures is skipped for the rest of the day, so one bad prompt
-- does not use the hourly batch. 1 row written per failed check, rows older than 8 days are deleted by the retention run.
CREATE TABLE ai_failures (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, engine, prompt_id)
) WITHOUT ROWID;

-- ai_crawler_days: how many rows ai_crawler_hits holds per site and UTC day, so the daily cap is one row read, not a
-- count over up to 2,000 index rows. It is filled from the existing rows here.
CREATE TABLE ai_crawler_days (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;
INSERT INTO ai_crawler_days (site_id, day, n) SELECT site_id, day, COUNT(*) FROM ai_crawler_hits GROUP BY site_id, day;
