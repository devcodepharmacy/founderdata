-- iOS apps: one site tracks a website and its app. App sessions use the hostname ios:<bundle id>.
-- app_bundle_id: App Store bundle id; app events and Apple notifications for any other bundle are refused.
-- accept_sandbox: 1 = store sandbox purchases (provider app_store_sandbox, never counted as revenue).
ALTER TABLE sites ADD COLUMN app_bundle_id TEXT;
ALTER TABLE sites ADD COLUMN accept_sandbox INTEGER NOT NULL DEFAULT 0;

-- Web visitor id carried into the app by a universal link (?ml_vid=...), so web visit, install and purchase are one journey.
ALTER TABLE visitors ADD COLUMN linked_web_vid TEXT;

-- App version and build of an app session, e.g. "1.4.0 (57)". NULL for web sessions.
ALTER TABLE sessions ADD COLUMN app_version TEXT;
