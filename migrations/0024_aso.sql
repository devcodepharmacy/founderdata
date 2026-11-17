-- ASO: keyword ranks, ratings and reviews of a site's iOS app (src/worker/aso.ts, docs/ASO.md).
-- The Worker can't fetch them: Apple answers 403 to Cloudflare's network. A collector on another machine
-- (scripts/aso-collect.mjs) reads the keywords and countries here, fetches from Apple and posts snapshots back.

-- The keywords tracked for a site's app, lowercase with single spaces. Each one is checked in every country.
CREATE TABLE aso_keywords (
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, keyword)
) WITHOUT ROWID;

-- Countries and competitors per site, as JSON arrays: ["us","de"] and ["123456789"]. No row: the default country.
CREATE TABLE aso_settings (
  site_id TEXT PRIMARY KEY,
  countries TEXT NOT NULL,
  competitors TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One snapshot per site, country and UTC day. A second push on the same day merges into it, keyword by keyword.
--   ranks    {"<keyword>": [rank or null, results, {"<competitor id>": rank or null}]}
--   top      {"<keyword>": [[id, name, subtitle, rating count, average rating, release day], ... up to 10]}
--   ratings  [[app id, name, rating count, average rating, version], ...] for the app and its competitors
--   sources  {"search"|"lookup"|"reviews": {"ok", "failed", "skipped", "status", "retryAfter"}}
-- The Worker writes these as JSON it built itself, and splices them into the read answers without parsing them.
CREATE TABLE aso_snapshots (
  site_id TEXT NOT NULL,
  country TEXT NOT NULL,
  day TEXT NOT NULL,
  collected_at INTEGER NOT NULL,
  app_id TEXT,
  ranks TEXT NOT NULL,
  top TEXT NOT NULL,
  ratings TEXT,
  sources TEXT,
  collector TEXT,
  PRIMARY KEY (site_id, country, day)
) WITHOUT ROWID;

-- Reviews from Apple's public feed, one row per review, insert only. id is Apple's review id.
CREATE TABLE aso_reviews (
  site_id TEXT NOT NULL,
  country TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  author TEXT,
  version TEXT,
  PRIMARY KEY (site_id, country, id)
) WITHOUT ROWID;

-- Apple Ads search popularity per keyword and country, for the last week Apple published. popularity is Apple's
-- 1 to 100 score across genres, popularity5 its 1 to 5 score. Both NULL: Apple has no score, because the term had
-- fewer than 500 searches that week.
CREATE TABLE aso_popularity (
  keyword TEXT NOT NULL,
  country TEXT NOT NULL,
  week TEXT NOT NULL,
  popularity INTEGER,
  popularity5 INTEGER,
  PRIMARY KEY (keyword, country)
) WITHOUT ROWID;

-- The last popularity import, one row: when it ran, the week it got and the error it stopped on.
CREATE TABLE aso_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  popularity_at INTEGER,
  popularity_week TEXT,
  popularity_error TEXT
);
