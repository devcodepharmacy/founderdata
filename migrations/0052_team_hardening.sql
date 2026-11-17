-- Teammate logins, review fixes (src/worker/team.ts, auth.ts).
-- name_key, email_key: the name and email folded in JavaScript (NFKC, lowercase), so "Änna" and "änna" are one person.
-- SQLite's lower() folds ASCII only. Rows from migration 0049 get the ASCII fold here; a name with a non-ASCII capital
-- signs in by its folded form after an owner resets the person, which rewrites the key.
-- created_by: the team member id behind a key or link made from a teammate's session, so revoking an owner revokes
-- what they made. NULL for everything made with ADMIN_PASSWORD and for rows from before this migration.
ALTER TABLE team_members ADD COLUMN name_key TEXT;
ALTER TABLE team_members ADD COLUMN email_key TEXT;
UPDATE team_members SET name_key = lower(name), email_key = lower(email);
DROP INDEX team_members_name;
DROP INDEX team_members_email;
CREATE UNIQUE INDEX team_members_name_key ON team_members (name_key);
CREATE UNIQUE INDEX team_members_email_key ON team_members (email_key) WHERE email_key IS NOT NULL;
ALTER TABLE api_keys ADD COLUMN created_by TEXT;
ALTER TABLE share_tokens ADD COLUMN created_by TEXT;
