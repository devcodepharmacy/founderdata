-- Teammate logins (src/worker/team.ts). One row per person, for the whole deployment, not per site.
-- role: viewer reads like the VIEWER_PASSWORD login, owner changes everything like ADMIN_PASSWORD.
-- password_hash: PBKDF2-SHA256 as pbkdf2-sha256$iterations$salt$hash, null until the person accepts the invite.
-- version: goes into the session cookie. A reset adds 1, so every cookie the person holds stops working. Deleting
-- the row (revoke) does the same.
-- invite_hash: SHA-256 of the one-time link token. The token itself is shown once and never stored.
CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'owner')),
  password_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  invite_hash TEXT,
  invite_expires INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX team_members_name ON team_members (lower(name));
CREATE UNIQUE INDEX team_members_email ON team_members (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX team_members_invite ON team_members (invite_hash) WHERE invite_hash IS NOT NULL;
