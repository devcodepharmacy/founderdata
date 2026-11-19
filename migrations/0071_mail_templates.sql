-- Mail templates (FounderData Pro, pro/worker/mail/templates.ts; docs/MAIL.md, "Templates"): stored HTML an app sends by
-- id or alias with variables, answered like Resend's Templates API. Core holds the tables, as for every Pro feature.
--
-- Each template belongs to one mail domain. The draft lives on the mail_templates row; each publish copies it into
-- mail_template_versions, and a send uses the published version. The 10 newest published versions are kept.
--
-- Rows written (pro/test/cost.test.ts pins them): creating a template 3 (the row, its key, its domain index entry; 1
-- more with an alias), changing its draft 1, publishing it 3 (the version row with its key, and the template row; the
-- version that falls out of the newest 10 is deleted for free). A send with a template writes 1 row more than the same
-- send without one: its entry in mail_messages_by_template.

-- A template.
--   domain_id          the mail domain it belongs to. Deleting the domain deletes its templates (domains.ts).
--   alias              a second name a send may use instead of the id, unique across the deployment
--   from_addr          the default From, `Name <a@b>` as given, on the template's domain. NULL: the send names it.
--   subject            the default subject. NULL: the send names it.
--   reply_to_json      JSON array of addresses, NULL for none
--   html, text         the draft's bodies. text NULL means "made from the HTML at send"; '' means no text part.
--   variables_json     JSON array of { key, type: string | number, fallback_value }
--   published_version  the version sends use, NULL until the first publish
--   has_draft          1 when the draft differs from the published version (Resend's has_unpublished_versions)
CREATE TABLE mail_templates (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  name TEXT NOT NULL,
  alias TEXT,
  from_addr TEXT,
  subject TEXT,
  reply_to_json TEXT,
  html TEXT NOT NULL,
  text TEXT,
  variables_json TEXT NOT NULL DEFAULT '[]',
  published_version INTEGER,
  has_draft INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE UNIQUE INDEX mail_templates_alias ON mail_templates (alias) WHERE alias IS NOT NULL;
-- The Templates tab groups by domain.
CREATE INDEX mail_templates_by_domain ON mail_templates (domain_id, created_at);

-- A published version of a template: the fields of mail_templates a send reads, as they were when it was published.
CREATE TABLE mail_template_versions (
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  from_addr TEXT,
  subject TEXT,
  reply_to_json TEXT,
  html TEXT NOT NULL,
  text TEXT,
  variables_json TEXT NOT NULL DEFAULT '[]',
  published_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
);

-- The template and version a sent message was made from. NULL for a message sent with its own html or text.
ALTER TABLE mail_messages ADD COLUMN template_id TEXT;
ALTER TABLE mail_messages ADD COLUMN template_version INTEGER;
-- A template's sent mail, newest first: its counts on the Templates tab and the Sent tab's template filter.
CREATE INDEX mail_messages_by_template ON mail_messages (template_id, created_at) WHERE template_id IS NOT NULL;
