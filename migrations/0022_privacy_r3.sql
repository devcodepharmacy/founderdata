-- Privacy and ops, round 3 (src/worker/privacy.ts, src/worker/auth.ts, docs/PRIVACY.md).

-- The erase log says who handled each request and which site it was, and outlives the site: deleting a site keeps
-- its erase log rows, because they are the proof that a request was answered. Still no identifier of the person.
ALTER TABLE erasures ADD COLUMN handled_by TEXT;  -- 'admin' (dashboard login) or 'api' (the site's API key); NULL before 0022
ALTER TABLE erasures ADD COLUMN note TEXT;        -- optional free text from the caller, such as a ticket number
ALTER TABLE erasures ADD COLUMN site_name TEXT;   -- "<name> (<domain>)" when the request was handled, refreshed on site delete

-- login_failures.ip now holds a keyed hash of the IP (HMAC with SESSION_SECRET), never the IP. Rows written before
-- this migration hold plain IPs and are at most 15 minutes of lockout state: drop them.
DELETE FROM login_failures;
