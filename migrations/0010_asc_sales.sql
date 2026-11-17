-- App Store Connect sales import (docs/MOBILE-API.md section 5).
-- Apple's daily Sales and Trends summary, one row per product, country, device and price point.
-- A row's amounts are per unit (as Apple sends them) in major units; units is negative for a refund.
-- Re-importing a day deletes its rows and writes them again, so row_key only has to be unique within a day.
CREATE TABLE asc_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  row_key TEXT NOT NULL,
  site_id TEXT,
  apple_id TEXT,
  parent_identifier TEXT,
  sku TEXT,
  title TEXT,
  product_type TEXT NOT NULL,
  kind TEXT NOT NULL, -- download, redownload, update, iap or other
  units INTEGER NOT NULL,
  proceeds REAL NOT NULL DEFAULT 0,
  proceeds_currency TEXT,
  customer_price REAL NOT NULL DEFAULT 0,
  customer_currency TEXT,
  country TEXT,
  device TEXT,
  UNIQUE (report_date, row_key)
);
CREATE INDEX asc_sales_site_day ON asc_sales (site_id, report_date);

-- One row per imported day. status: ok (rows written), zero (Apple reported no sales) or error.
CREATE TABLE asc_import_days (
  report_date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL
);

-- The site's app in App Store Connect, resolved once from app_bundle_id.
ALTER TABLE sites ADD COLUMN asc_app_id TEXT;
ALTER TABLE sites ADD COLUMN asc_sku TEXT;
