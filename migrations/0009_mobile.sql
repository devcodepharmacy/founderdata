-- Phones signed in through the mobile API (docs/MOBILE-API.md). One row per signed-in phone. Only the SHA-256 of its bearer token is
-- stored. Revoking a device sets revoked_at and clears its push tokens, so a revoked row never receives a push.
-- apns_* is the alert token and widget_* the WidgetKit push token. Both carry their own environment (sandbox or
-- production) and topic (the app's bundle id). *_disabled_at is set when APNs rejects the token for good and
-- cleared when the app registers it again. events is the JSON of the event switches (purchase, renewal, refund,
-- trial), per device. last_widget_push_at throttles widget pushes to one per 5 minutes.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  apns_token TEXT,
  apns_env TEXT,
  apns_topic TEXT,
  apns_disabled_at INTEGER,
  widget_token TEXT,
  widget_env TEXT,
  widget_topic TEXT,
  widget_disabled_at INTEGER,
  last_widget_push_at INTEGER,
  events TEXT NOT NULL DEFAULT '{"purchase":true,"renewal":true,"refund":false,"trial":false}'
);
CREATE UNIQUE INDEX devices_token ON devices (token_hash);
CREATE INDEX devices_live ON devices (revoked_at, created_at);

-- Per-device switches. A site or product with no row is on, so these hold only what a person touched.
CREATE TABLE device_site_prefs (
  device_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (device_id, site_id)
) WITHOUT ROWID;
CREATE INDEX device_site_prefs_site ON device_site_prefs (site_id, enabled);

CREATE TABLE device_product_prefs (
  device_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  product TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (device_id, site_id, product)
) WITHOUT ROWID;
CREATE INDEX device_product_prefs_site ON device_product_prefs (site_id, enabled);
