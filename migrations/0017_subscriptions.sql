-- Subscription state (src/worker/subscriptions.ts, docs/GUIDE.md "Subscriptions"): one row per subscription, upserted
-- on each lifecycle event from Stripe, App Store Server Notifications, RevtrailKit and RevenueCat. The Subscriptions tab
-- and the MRR on the home page read it. `id` is the provider's subscription id, the same value payments.subscription_id
-- holds (Stripe sub_..., the App Store original transaction id), so a payment finds its subscription.
--
-- Times are ms. MRR fields are monthly amounts in the site's currency, minor units. The history the charts draw comes
-- from the times: a subscription counts in MRR from paid_at until its end, at first_mrr until mrr_changed_at and at mrr
-- after it. Its end is ended_at, or expires_at when no renewal came for 30 days after it.
--
-- WITHOUT ROWID with no other index: an event writes 1 row. Reads go by site_id, the first key column.
CREATE TABLE subscriptions (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,           -- stripe, app_store, revenuecat, app_store_sandbox, or the payment's provider
  customer_id TEXT,
  visitor_id TEXT,                  -- who it is credited to, like a payment
  session_id TEXT,                  -- the credited visit
  channel TEXT,                     -- snapshot of the credited visit, kept when old visits are deleted
  source TEXT,
  source_domain TEXT,
  campaign TEXT,
  product TEXT,
  status TEXT NOT NULL,             -- trialing, active, past_due, canceled (will not renew), expired, incomplete
  currency TEXT,                    -- currency of `amount`
  amount INTEGER,                   -- price per period in `currency`, minor units
  interval TEXT,                    -- day, week, month or year
  interval_count INTEGER,
  mrr INTEGER,                      -- `amount` per month in the site's currency
  first_mrr INTEGER,                -- mrr when the first payment came
  mrr_changed_at INTEGER,           -- last time a paid subscription changed price (upgrade, downgrade)
  trial_start INTEGER,
  trial_end INTEGER,
  started_at INTEGER NOT NULL,
  paid_at INTEGER,                  -- first payment: the trial converted, or the subscription started paid
  renewed_at INTEGER,               -- latest payment
  expires_at INTEGER,               -- end of the period paid for (or of the trial)
  canceled_at INTEGER,              -- auto-renew turned off; NULL again when turned back on
  ended_at INTEGER,                 -- access ended: churn for a paid subscription
  billing_issue_at INTEGER,         -- latest failed payment; past due while later than renewed_at
  sandbox INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,      -- event time of the newest event applied
  rev INTEGER NOT NULL DEFAULT 0,   -- bumped on every write, so two events at once cannot overwrite each other
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
