-- More payment providers (src/worker/lemonsqueezy.ts, polar.ts, paddle.ts, gumroad.ts), one secret per site, set in
-- Settings. Lemon Squeezy, Polar and Paddle sign each webhook with it. Gumroad signs nothing: its ping URL carries a
-- random token, and each sale ping must name the seller id saved here (typed in, or taken from the first sale ping).
ALTER TABLE sites ADD COLUMN lemonsqueezy_secret TEXT;
ALTER TABLE sites ADD COLUMN polar_secret TEXT;
ALTER TABLE sites ADD COLUMN paddle_secret TEXT;
ALTER TABLE sites ADD COLUMN gumroad_seller_id TEXT;
ALTER TABLE sites ADD COLUMN gumroad_token TEXT;

-- Stripe history import (src/worker/stripe-import.ts), one row per site. The dashboard runs it in steps; each step
-- reads one page of charges and moves `cursor` on, so an import that stops resumes where it was. The restricted key is
-- kept only while the import runs and set to NULL when it finishes, fails or is canceled.
CREATE TABLE stripe_imports (
  site_id TEXT PRIMARY KEY,
  stripe_key TEXT,             -- rk_live_..., NULL once the import is no longer running
  status TEXT NOT NULL,        -- running, done, failed, canceled
  since INTEGER NOT NULL,      -- oldest charge to import, ms
  cursor TEXT,                 -- id of the last charge handled (Stripe lists newest first)
  cursor_ts INTEGER,           -- its time, ms: how far back the import has come
  seen INTEGER NOT NULL DEFAULT 0,      -- charges read
  recorded INTEGER NOT NULL DEFAULT 0,  -- payments stored by the import
  skipped INTEGER NOT NULL DEFAULT 0,   -- charges already stored, not paid, test mode or another site's
  error TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
