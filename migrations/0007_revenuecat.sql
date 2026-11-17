-- RevenueCat webhook (POST /api/webhooks/revenuecat/:siteId). The secret RevenueCat sends in the
-- Authorization header, one per site, set in Settings.
ALTER TABLE sites ADD COLUMN revenuecat_auth TEXT;

-- App Store product id or the app's pack id of a payment, so the paywall panel can show purchases per product.
-- A column, not a table: the payment INSERT writes it, so it adds no D1 rows.
ALTER TABLE payments ADD COLUMN product TEXT;

-- Subscription events that are not money: trial starts, cancellations (churn signal), expirations, billing
-- issues and product changes, from RevenueCat. One row per RevenueCat event id, so a retried delivery writes
-- nothing. WITHOUT ROWID with the primary key first keeps a signal at 2 rows written (row + time index).
CREATE TABLE subscription_signals (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  visitor_id TEXT,
  session_id TEXT,
  product TEXT,
  store TEXT,
  reason TEXT,
  sandbox INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
CREATE INDEX subscription_signals_site_time ON subscription_signals (site_id, ts);
