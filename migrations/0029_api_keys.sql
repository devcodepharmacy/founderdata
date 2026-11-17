-- Scoped API keys (src/worker/keys.ts, docs/API.md "API keys"): one key per agent or script, with only the scopes it
-- needs, optionally limited to some sites and to a date. The secret (fdk_...) is shown once and only its SHA-256 is
-- stored. The older keys keep working: read keys (share_tokens, rtr_...) and each site's API key (sites.api_key, rt_...).
--   hash           SHA-256 of the secret, hex. The primary key, so a lookup is one row and an insert writes one row.
--   id             public id the dashboard and DELETE /api/v1/keys/<id> use. No index: a deployment has 50 keys at most.
--   hint           the secret's last 4 characters, so the owner can tell keys apart
--   scopes         JSON array: read, read:revenue, notes:write, alerts:write, payments:write
--   sites          JSON array of site ids, or NULL for every site, including sites added later
--   last_used_at, last_write_at   ms, written at most once a minute per key (with the calls below)
--   hours          calls per hour for the last 24 hours: 24 pairs [hour number since 1970, calls], slot hour % 24.
--                  A slot whose hour is older than 24 hours counts 0.
CREATE TABLE api_keys (
  hash TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  scopes TEXT NOT NULL,
  sites TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_write_at INTEGER,
  hours TEXT NOT NULL DEFAULT '[[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]]'
) WITHOUT ROWID;
