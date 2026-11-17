-- A dated result of "Check against Stripe" (src/worker/stripe-check-history.ts, docs/GUIDE.md "Check MRR against Stripe").
-- One row per site and day in the site's timezone; a second check the same day overwrites it. The Stripe key and the
-- subscriptions are never stored, only these totals. The 03:17 cleanup deletes rows older than 400 days.
--   fd_mrr, stripe_mrr   monthly amounts in minor units of the site currency
--   gap_count            subscriptions that are in Stripe only, in FounderData only, or differ in amount
--   gap_amount           the monthly amount those subscriptions are worth, in minor units
--   status               matches (within 0.5%) or differs
CREATE TABLE stripe_check_history (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  fd_mrr INTEGER NOT NULL,
  stripe_mrr INTEGER NOT NULL,
  gap_count INTEGER NOT NULL,
  gap_amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;
