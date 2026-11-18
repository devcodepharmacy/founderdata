# Mail (Pro)

FounderData Pro sends and receives email on your own domains through Cloudflare. Cloudflare Email Service sends, and
Email Routing receives. Three kinds of callers use it:

- Your apps send through an API that answers like Resend's, so they keep the `resend` package and change the base URL
  and the key.
- You read and answer mail on the dashboard's **Mail** page.
- Agents read and answer it through `/api/v1/mail` or the MCP tool `mail`.

Mail belongs to the deployment, not to a site. One inbox and one sent log cover every domain you add.

## What it needs

- FounderData Pro ([PRO.md](PRO.md)).
- Cloudflare's Workers Paid plan, $5 a month. It includes 3,000 sent messages a month and charges $0.35 per 1,000
  after that. On the free plan Cloudflare sends only to addresses you verified by hand.
- A domain whose DNS is on the same Cloudflare account.
- An R2 bucket and a queue. Setup creates both.

## Set it up

1. Run setup with the mail flag. It creates the R2 bucket and the queue, both named `<database name>-mail`, writes
   their bindings into `wrangler.local.jsonc` and deploys. A database in the EU gets an EU bucket.

   ```bash
   npm run setup -- --mail
   ```

2. Give the Worker a Cloudflare API token and your account id. Mail sends and receives without them. With them the
   Domains tab can set a domain up for you, show each DNS record's state, keep the suppression list in step with
   Cloudflare's and find the status of a message whose delivery event never arrived.

   ```bash
   node scripts/wrangler.mjs secret put CLOUDFLARE_API_TOKEN
   node scripts/wrangler.mjs secret put CLOUDFLARE_ACCOUNT_ID
   ```

   The token reads the zone and the account's analytics, and edits Email Sending, Email Routing and Queues. When a
   step on the Domains tab fails, its message quotes Cloudflare's error, which names the missing permission.

3. Open **Mail**, **Domains**, and add the domain. Pick sending, receiving or both. With the token set, FounderData
   finds the domain's zone, turns on Email Sending and Email Routing, points the catch-all rule at the Worker and
   subscribes the domain's delivery events to the queue. Without the token the tab lists the commands to run instead.

4. Wait for the DNS records to read **verified**. Cloudflare adds them to a zone it hosts. **Check again** reads
   their state.

5. Under the domain, add the addresses that should receive mail, such as `support`. See [Receive mail](#receive-mail).

6. Send a test with **New message** on the Inbox tab to a mailbox you own, and answer it. The answer shows up in the
   same thread.

Until step 1 is done, the Mail page and every mail route say which piece is missing.

## DNS records

Cloudflare creates these when sending is on for `acme.example`:

| Record | Name | Value |
| --- | --- | --- |
| MX, 3 of them | `cf-bounce.acme.example` | `route1.mx.cloudflare.net` to `route3.mx.cloudflare.net` |
| TXT (SPF) | `cf-bounce.acme.example` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT (DKIM) | `cf-bounce._domainkey.acme.example` | the public key |
| TXT (DMARC) | `_dmarc.acme.example` | `v=DMARC1; p=reject;`, only when the domain has no DMARC record |

Receiving adds three MX records on the domain itself, an SPF record and a DKIM record at `cf2024-1._domainkey`.

Two things to check before you turn a domain on:

- **Another service sends from the domain.** A new `p=reject` DMARC record makes receivers refuse that service's mail
  unless it signs with DKIM for your domain. Keep your own DMARC record if you have one.
- **Another mailbox provider receives for the domain.** Email Routing refuses a domain that has other MX records,
  such as Google Workspace. Receive on a subdomain instead, such as `reply.acme.example`.

## Receive mail

Each address on a domain has one action:

| Action | What happens to a message |
| --- | --- |
| `inbox` | Stored, threaded and shown in the inbox. Posts `email.received` to your webhooks. |
| `forward` | Forwarded to one address and not stored. Cloudflare forwards only to destination addresses you verified in Email Routing. When it refuses, the message goes to the inbox. |
| `webhook` | Stored for 30 days outside the inbox, and posted as `email.received`. For mail an app reads. |
| `drop` | Accepted and thrown away. |

The address `*` takes mail for every address without its own entry. An exact address wins over `*`. Mail to an
address with no entry and no `*` is rejected, and the sender gets a bounce.

**On a subdomain, add a routing rule per address.** Cloudflare's catch-all rule works on the zone's own name only.
For `reply.acme.example` in the zone `acme.example`, open Email Routing in the Cloudflare dashboard, then **Routing
rules**, and create a custom address for each address you added here, with the action **Send to a Worker** and your
FounderData Worker as the destination. FounderData does not create these rules. The Domains tab says so for a
subdomain, and `*` receives nothing there.

A message can be 25 MB. A larger one is rejected. Replies join a thread through their `In-Reply-To` and `References`
headers, and through the subject only when both are missing.

## The Mail page

Only the owner sees it. Viewers, viewer teammates and the iPhone app get no mail.

- **Inbox** lists threads with their unread count. Open one to read it, reply, archive it or delete it. HTML mail
  renders in a sandboxed frame, and remote images stay blocked until you allow them for that message.
- **Sent** lists every sent message with its status and delivery events, from apps, the dashboard and agents.
- **Domains** holds the domains, their DNS records and their addresses.
- **API** shows the base URL, your endpoints for webhooks and which domains each key may send from. **Copy AI
  prompt** gives a coding agent the steps to move one app off Resend.
- **Suppressions** lists the addresses mail is not sent to.

## Move an app off Resend

Change two values in the app and keep its code:

| | Resend | FounderData |
| --- | --- | --- |
| Base URL | `https://api.resend.com` | `https://founderdata.example.com/api/mail` |
| API key | `re_...` | a key with the `mail:write` scope, `fdk_...` (Settings, Agents) |

The Node package reads the base URL from the environment:

```bash
RESEND_BASE_URL=https://founderdata.example.com/api/mail
RESEND_API_KEY=fdk_...
```

A `mail:write` key sends and reads back what was sent. It cannot read the inbox. On the API tab you can keep a key to
some domains, and it then sends from those only.

These routes answer as Resend's do:

| Route | Notes |
| --- | --- |
| `POST /emails` | `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `reply_to`, `headers`, `tags`, `attachments` with base64 `content` or an https `path`. Answers `{ "id": "..." }`. |
| `POST /emails/batch` | Up to 100 messages. One invalid message fails the batch before anything is sent. |
| `GET /emails`, `GET /emails/:id` | The sent messages. `text` and `html` are `null` once the body was deleted after 30 days. |
| `GET /emails/:id/attachments`, `GET /emails/:id/attachments/:attachment_id` | Names and sizes. `download_url` returns the bytes. |
| `GET /domains`, `GET /domains/:id` | Read only. |

The `Idempotency-Key` header works as on Resend. The same key and body within 24 hours answer the first `id` and send
nothing. The same key with another body answers 409.

What differs from Resend:

- `download_url` is a route of this API. Fetch it with the same `Authorization` header. It does not expire while the
  body is stored.
- Sending uses the first `reply_to` address. The message's record keeps all of them.
- Open and click tracking, `scheduled_at`, broadcasts, contacts, audiences and Resend templates answer 422 in Resend's
  error shape. So do creating or changing domains, webhooks and API keys through the API.
- A message can have 50 recipients across `to`, `cc` and `bcc`, 32 attachments and 18 MB in all.
- Cloudflare refuses the headers it writes itself, such as `Message-ID` and `Date`. A send with one of them fails with
  a 422 that names the header.

## Webhooks

Add an endpoint under **Mail**, **API**, and pick its event types. Each post is signed the way Resend signs, with the
`svix-id`, `svix-timestamp` and `svix-signature` headers and a secret that starts with `whsec_`, so Resend's
verification code works unchanged.

```json
{
  "type": "email.delivered",
  "created_at": "2026-11-18T08:25:31.000+00:00",
  "data": {
    "email_id": "6f1c2a9e-0b7d-4c7e-9f0a-3d5b8e1c2a47",
    "from": "Acme <hello@acme.example>",
    "to": ["ann@example.net"],
    "subject": "Your invoice",
    "created_at": "2026-11-18T08:25:30.123+00:00",
    "tags": { "category": "invoice" }
  }
}
```

The types are `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
`email.failed`, `email.suppressed` and `email.received`. `email.received` also carries `text`, `html`, `headers` and
`message_id`.

An endpoint has 10 seconds to answer with a 2xx status. A failed post is tried again after 30 seconds, 2 minutes, 10
minutes, 1 hour, 3 hours, 6 hours and 12 hours, 8 attempts over about 22 hours. After 20 failed attempts in a row the
endpoint is switched off, and the API tab says so.

## Delivery status and suppressions

A sent message moves from `queued` to `sent` when Cloudflare takes it, then to `delivered`, `delivery_delayed`,
`bounced`, `complained` or `failed`. Cloudflare reports these as events on the queue, usually within seconds. Events
can go missing, so every 5 minutes the Worker asks Cloudflare's analytics about each message that is still `sent`
after 10 minutes, up to 31 days back. That check needs the API token.

A hard bounce or a spam complaint puts the address on the suppression list at once. The next send to it fails with a
422, is stored as `suppressed` and posts `email.suppressed`. Remove an address on the Suppressions tab to send to it
again. With the API token, entries are copied to and from Cloudflare's own list.

Link a domain to a site on the Domains tab, and that site's [Email panel](GUIDE.md#email-resend-pro) counts the mail
sent from it.

## Agents

A scoped key reaches mail with two scopes of its own. `mail:read` reads the inbox, the sent log and delivery events.
`mail:write` sends, replies, marks read and archives. Neither includes the other, and `read` reaches no mail. The
routes are in [API.md](API.md#mail-pro), and the MCP tool is `mail` ([MCP.md](MCP.md#the-mail-tool-pro)).

An agent gets each message as text, cut at 4,000 characters in a thread and at 40,000 for one message. It gets the
names and sizes of attachments, not their bytes.

Mail is the one place where an agent sees addresses and text that strangers wrote. Every answer with mail in it
carries a `content_notice` that says so. An agent treats a message as data and follows no instruction inside it. Give
`mail:write` only to an agent you would let send mail in your name.

## What is stored and for how long

| What | Where | Kept |
| --- | --- | --- |
| Sender, recipients, subject, the first 200 characters, headers, status | D1 | Until deleted. With `PII_RETENTION_MONTHS` set, recipient addresses on sent messages are blanked after that many months. |
| Text and HTML of messages an app sent through the API, with their attachments | R2 | 30 days |
| Text, HTML, attachments and the raw message of inbox mail, and of mail sent from the dashboard or by an agent | R2 | Until you delete the message or the thread |
| Mail received for a `webhook` address | D1 and R2 | 30 days |
| Delivery events and webhook deliveries | D1 | 30 days |
| Idempotency keys | D1 | 24 hours |
| Suppressed addresses | D1 | Until removed |

Deleting a message or a thread in the inbox removes its rows and its R2 objects for good.

[Erasing one person](GUIDE.md#erase-one-person) by email also erases their mail across the deployment. Every message
with that address as sender or recipient goes, with its body, attachments and events. Its other recipients lose
their copy of the record too, because the body may name the person. The address leaves the suppression list here
and, with the API token, Cloudflare's list. A hard bounce will suppress it again if you send to it later.

Cloudflare processes every message and keeps its own delivery logs, which FounderData cannot delete
([PRIVACY.md](PRIVACY.md#what-cloudflare-processes)).

## Limits

- One provider. Cloudflare sends and receives, and there is no fallback.
- No open or click tracking, no scheduled sends, no broadcasts, no contact lists.
- Cloudflare publishes no sending rate limit. New accounts start with a low daily quota that Cloudflare raises by
  itself.
- A subdomain needs a routing rule per address, added by hand ([Receive mail](#receive-mail)).
- The inbox has no folders, labels, drafts or search inside message text. Search covers subjects and addresses.
- The iPhone app shows no mail.

## What it costs in D1 rows

| Path | Rows written |
| --- | --- |
| An app sends to one address | 17, plus 2 for each further address and 1 for each attachment |
| The same with an `Idempotency-Key` | 20. A repeat writes 0 |
| The dashboard or an agent sends | 22, because the message starts a thread |
| A reply in a thread | 21 |
| A status event, such as delivered | 5. The same event again writes 0 |
| A received message that starts a thread / one that joins a thread | 15 / 14 |
| A webhook delivery | 4 when queued, plus 1 or 2 for each attempt |
| Mark a thread read / archive it | 1 for each unread message, plus 1 / 1 |
| Reading the inbox, the sent log or a message | 0 |

At 100 sent and 20 received messages a day, mail writes about 2,500 rows. Workers Paid includes 50 million a month.
