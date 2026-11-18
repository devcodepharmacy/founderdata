-- Mail: send and receive email on the deployment's own domains through Cloudflare Email Service (FounderData Pro,
-- pro/worker/mail/). Core holds the tables, as for every Pro feature, so a database moves between editions without a
-- migration of its own. Core never writes them.
--
-- No table has a site_id: mail belongs to the deployment. mail_domains.site_id only links a domain to a site's
-- email_daily numbers, and deleting the site sets it to NULL. Times are ms since the epoch. Message bodies, raw MIME
-- and attachments live in the MAIL_BUCKET R2 bucket, never in D1.
--
-- Rows each path writes. D1 counts an index entry an insert or update adds as a row (removing one is free), so these
-- include the indexes. pro/test/cost.test.ts measures and pins them all.
--   queue a send to N addresses  4 for the message (row, primary key, created and thread indexes) + 2 per address
--                                (the sender counts as one, and from, to, cc, bcc and reply_to count together),
--                                + 2 with an Idempotency-Key, + 1 per attachment, + 5 for the thread a send from the
--                                dashboard or an agent starts
--   mark it sent                 9: the message with its provider_id and open indexes (3), its Message-ID lookup (2),
--                                its `sent` row in mail_events (4), + 1 to close an Idempotency-Key
--   so a send to one address     17 from an app, 20 with an Idempotency-Key, 22 from the dashboard or an agent
--   a later status change        1 for the message, + 4 for its mail_events row
--   one inbound message          4 + 2 per address + 2 for its Message-ID, its thread 5 when new and about 4 when it
--                                grows, + 1 per attachment
--   one webhook delivery         4 when queued (row, primary key, webhook and due indexes), 1 or 2 per attempt

-- A domain the deployment sends from or receives on.
--   name         lowercased, such as mail.acme.example
--   site_id      optional link to a site, for that site's email_daily numbers
--   zone_id      the Cloudflare zone the domain lives in, for the domain API calls
--   sending      1 when Email Sending is on for the domain
--   receiving    1 when Email Routing sends the domain's mail to this Worker
--   checked_at   last time the status was read from Cloudflare
--   status_json  the last status read: DNS records with their state, routing and sending settings
CREATE TABLE mail_domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  site_id TEXT,
  zone_id TEXT,
  sending INTEGER NOT NULL DEFAULT 0,
  receiving INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  status_json TEXT
);

-- What happens to mail sent to an address on a domain. local is the lowercased part before the @, or * for the
-- catch-all. An exact address wins over the catch-all.
--   action  inbox (keep it), forward (to forward_to, a verified destination address), webhook (post email.received),
--           drop (accept and discard)
CREATE TABLE mail_addresses (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  local TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'inbox',
  forward_to TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (domain_id, local)
);

-- One message, sent or received.
--   id               a UUID, the id the Resend-compatible API returns
--   direction        in or out
--   provider_id      Cloudflare's messageId for a sent message, set in the statement that marks it sent. It equals
--                    the Message-ID header the recipient sees, angle brackets included.
--   from_addr        the human sender (the From header, never the envelope sender of inbound mail)
--   to_json, cc_json, bcc_json, reply_to_json  JSON arrays of addresses
--   status           out: queued, sent, delivery_delayed, delivered, bounced, complained, failed, suppressed.
--                    in: received
--   status_rank      0 queued, 1 sent, 2 delivery_delayed, 3 delivered, 4 bounced, failed or suppressed, 5 complained.
--                    An update only moves it up (pro/worker/mail/store.ts advanceStatus).
--   snippet          the first 200 characters of the text body
--   headers_json     the custom headers sent, or the inbound message's headers
--   source           api, dashboard, agent or inbound
--   key_id           the API key that sent it, NULL otherwise
--   error            the provider's error code and message when the send failed
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  domain_id TEXT,
  thread_id TEXT,
  provider_id TEXT,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT,
  bcc_json TEXT,
  reply_to_json TEXT,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT,
  headers_json TEXT,
  source TEXT NOT NULL,
  key_id TEXT,
  read_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error TEXT
);
-- The sent log and the received list, newest first, and the retention cleanup.
CREATE INDEX mail_messages_by_created ON mail_messages (direction, created_at);
-- A thread's messages in order.
CREATE INDEX mail_messages_by_thread ON mail_messages (thread_id, created_at);
-- Cloudflare's events and the reconciliation join on messageId.
CREATE INDEX mail_messages_by_provider ON mail_messages (provider_id) WHERE provider_id IS NOT NULL;
-- Sent messages without a final status, for the reconciliation job.
CREATE INDEX mail_messages_open ON mail_messages (created_at) WHERE direction = 'out' AND status_rank IN (1, 2);

-- Every address on a message (from, to, cc, bcc, reply_to), lowercased: erasing a person finds their messages here.
CREATE TABLE mail_parties (
  message_id TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (message_id, address)
) WITHOUT ROWID;
CREATE INDEX mail_parties_by_address ON mail_parties (address);

-- Attachment metadata. The bytes are in R2 at msg/<message id>/att/<n>.
--   cid  the Content-ID of an inline image, without angle brackets
CREATE TABLE mail_attachments (
  message_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  cid TEXT,
  PRIMARY KEY (message_id, n)
) WITHOUT ROWID;

-- A conversation. Threading follows References and In-Reply-To against mail_message_ids, and the subject only when
-- both headers are missing.
--   address_id         the address that received the thread's first inbound message, NULL for a thread started by
--                      a sent message
--   unread             inbound messages not read yet
--   participants_json  JSON array of the outside addresses in the thread
CREATE TABLE mail_threads (
  id TEXT PRIMARY KEY,
  domain_id TEXT,
  address_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  last_at INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  participants_json TEXT NOT NULL DEFAULT '[]',
  archived_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_threads_by_last ON mail_threads (last_at);
CREATE INDEX mail_threads_by_domain ON mail_threads (domain_id, last_at);
CREATE INDEX mail_threads_by_address ON mail_threads (address_id, last_at);

-- Message-ID header values (angle brackets included) and the message that carries them, for threading and for joining
-- events. Several stored messages can share one header (the same mail to two of our addresses), and the first one wins.
CREATE TABLE mail_message_ids (
  message_id_header TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX mail_message_ids_by_message ON mail_message_ids (message_id);

-- One row per provider event, keyed by the provider's eventId, so a redelivered event writes nothing.
--   type         sent, delivered, delivery_delayed, bounced, complained, failed, suppressed (the Resend event without
--                its email. prefix)
--   at           the event's own time
--   detail_json  bounce type, SMTP response and similar
CREATE TABLE mail_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  type TEXT NOT NULL,
  recipient TEXT,
  at INTEGER NOT NULL,
  detail_json TEXT
);
CREATE INDEX mail_events_by_message ON mail_events (message_id, at);
CREATE INDEX mail_events_by_at ON mail_events (at);

-- The Idempotency-Key header of the Resend-compatible API, kept 24 hours.
--   key_id      the API key's id ('' for the dashboard)
--   body_hash   SHA-256 of the request body: the same key with another body answers 409
--   message_id  the message id, or for /emails/batch a JSON array of ids
--   state       pending while the send runs, done after
CREATE TABLE mail_idempotency (
  key_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  message_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
) WITHOUT ROWID;
CREATE INDEX mail_idempotency_by_created ON mail_idempotency (created_at);

-- Addresses no message goes to. Written the moment a hard bounce or a complaint is known: Cloudflare's own list lags
-- by about 10 minutes.
--   domain_id    the sending domain the entry covers, '' for every domain
--   reason       bounce, complaint, unsubscribe or manual
--   provider_id  the id of the matching entry on Cloudflare's suppression list, once synced
CREATE TABLE mail_suppressions (
  address TEXT NOT NULL,
  domain_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  source_message_id TEXT,
  provider_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (address, domain_id)
) WITHOUT ROWID;

-- Endpoints that get signed event posts (Svix format, like Resend's).
--   secret       whsec_ followed by base64
--   events_json  JSON array of event types, such as ["email.delivered", "email.bounced"]
--   domain_id    only events of this domain's messages, or NULL for all
--   failures     deliveries that failed in a row, and at 20 the endpoint is switched off (enabled 0)
CREATE TABLE mail_webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  domain_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One event for one endpoint, with its attempts. Kept 30 days.
--   message_id   the message the event is about, so erasing a person removes its deliveries
--   event_json   the payload as posted
--   status       pending, delivered or failed (attempts used up, or the endpoint switched off)
--   last_status  the HTTP status of the last attempt, 0 for a network error
CREATE TABLE mail_webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  message_id TEXT,
  event_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  last_status INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_webhook_deliveries_by_webhook ON mail_webhook_deliveries (webhook_id, created_at);
CREATE INDEX mail_webhook_deliveries_due ON mail_webhook_deliveries (next_at) WHERE status = 'pending';

-- A key with rows here sends only from these domains. A key without rows sends from every domain.
CREATE TABLE mail_key_domains (
  key_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  PRIMARY KEY (key_id, domain_id)
) WITHOUT ROWID;
