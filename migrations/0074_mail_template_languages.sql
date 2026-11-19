-- Languages of a mail template (FounderData Pro, pro/worker/mail/templates.ts; docs/MAIL.md, "Languages"). A template
-- has one default language, kept in the existing subject, html and text columns, and spin-offs: the same email in
-- other languages, each with its own subject, html and text. Every language shares the template's name, alias, from
-- address and variables, and a publish puts out all of them as one version.
--
-- Rows written: none more than before. The columns are on rows a save, a publish and a send already write, and none
-- is indexed.

-- The default language, such as en or de. NULL for a template written before languages, which reads as en.
ALTER TABLE mail_templates ADD COLUMN language TEXT;
-- The spin-offs: JSON object of language to { subject, html, text }. NULL for none.
ALTER TABLE mail_templates ADD COLUMN languages_json TEXT;
ALTER TABLE mail_template_versions ADD COLUMN language TEXT;
ALTER TABLE mail_template_versions ADD COLUMN languages_json TEXT;

-- The language a sent message was made in, after the fallback: the one asked for, its base language, or the default.
ALTER TABLE mail_messages ADD COLUMN template_language TEXT;
