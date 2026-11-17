-- A payment in another currency than its site's is converted at the ECB reference rate of the payment's day
-- (src/worker/fx.ts), so revenue totals count every payment. amount_conv is the amount in the site's currency,
-- in its minor unit; NULL until converted, and reset when the site's currency changes.
ALTER TABLE payments ADD COLUMN amount_conv INTEGER;

-- ECB reference rates, units of `currency` per 1 EUR, one row per day and currency. A row for EUR marks the day
-- as fetched, so a currency the ECB does not publish is not asked for again.
CREATE TABLE fx_rates (
  day TEXT NOT NULL,
  currency TEXT NOT NULL,
  per_eur REAL NOT NULL,
  PRIMARY KEY (day, currency)
) WITHOUT ROWID;
