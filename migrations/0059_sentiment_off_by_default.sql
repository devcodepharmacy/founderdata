-- Sentiment rating is opt-in (src/worker/ai-extra.ts, docs/AI-VISIBILITY.md "Sentiment"). 0054 switched it on at 20 answers a
-- day for every site, which spent the owner's engine key without being asked. Every row goes to 0 (off); the owner turns it on
-- in the AI tab or with sentiment_per_day. A site without a row reads 0 in code, and saving settings writes the value.
-- 1 row written per site with AI settings, once.
UPDATE ai_settings SET sentiment_per_day = 0 WHERE sentiment_per_day != 0;
