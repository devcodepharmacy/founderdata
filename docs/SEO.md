# SEO snapshots

The SEO tab shows a snapshot of search data. Search Console can fill it two ways. The Worker pulls it on its own after
you click Connect Google ([Connect Google](#connect-google)), or `scripts/gsc-sync.mjs` pushes it from your machine
([Sync Search Console](#sync-search-console)). Keyword tools, SERP checks and anything else you track still arrive as
a snapshot you build elsewhere and push to the Worker. Until a site has a snapshot, its SEO tab shows how to send one.

## Pushing a snapshot

Log in with the admin password, then `PUT` each part as JSON:

```bash
BASE=https://founderdata.example.com
SITE=<site id>
curl -sc /tmp/rt-cookie -H 'content-type: application/json' \
  -d "{\"password\":\"$(cat ~/.config/founderdata/admin-password)\"}" "$BASE/api/auth/login"
for part in meta gsc_daily gsc_queries gsc_pages gsc_page_queries; do
  curl -sb /tmp/rt-cookie -X PUT -H 'content-type: application/json' --data-binary "@$part.json" "$BASE/api/sites/$SITE/seo/$part"
done
```

Or push with a scoped key that has the `seo:write` scope (Settings, Agents), with no admin password. Send it in
place of the cookie:

```bash
for part in meta gsc_daily gsc_queries gsc_pages gsc_page_queries; do
  curl -s -X PUT -H "Authorization: Bearer $(cat ~/.config/founderdata/seo-key)" -H 'content-type: application/json' \
    --data-binary "@$part.json" "$BASE/api/sites/$SITE/seo/$part"
done
```

The key may push only to the sites it covers, and may read the snapshot back with `GET /api/sites/:id/seo`. A key
without `seo:write` gets `403` ([API.md](API.md#seo-and-aso-writes)).

Each part is one row in `seo_snapshots`, up to 1.9 MB, and a push replaces the previous one. A new part writes 2 D1 rows and a
replaced part 1. `GET /api/sites/:id/seo` returns `{ pushedAt, parts }`. The Worker stores the text as sent and never parses
it. The dashboard sums the rows in the browser (`pro/dashboard/lib/seo.ts`).

Only `meta` is required. Without it the tab shows the empty state. Without `gsc_daily` it shows the rest and says
Search Console is not measured.

## Connect Google

The Worker can read Search Console itself. You sign in to Google once in the browser, pick a property per site, and the
cron fills the snapshot once an hour. No machine of yours stays involved. A site has up to 16 months of queries after
the backfill, which takes about 50 runs, so about two days. It uses your own Google Cloud project, so nothing goes through a
third party and nobody else holds your Search Console access.

### Set up the Google client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project or pick one. Under APIs and
   services, Library, enable the **Google Search Console API**.
2. Open the OAuth consent screen (**Google Auth platform** in the newer console). Choose user type **External**, give
   the app a name and your email, and add the scope `https://www.googleapis.com/auth/webmasters.readonly` under Data
   access. While the app is in Testing, add your own Google account as a test user.
3. Under Clients, create a client of type **Web application**. Add this authorized redirect URI, with your own host:

   ```
   https://founderdata.example.com/api/seo/google/callback
   ```

   The SEO tab shows the exact URI of the host you are on. It must match character for character, including `https`.
4. Give the Worker the client id and secret, then open the SEO tab:

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   `npm run setup` leaves secrets you set this way alone. Without both, the tab shows these steps instead of the button.
5. In the SEO tab, click **Connect Google** and approve the read-only access. Back in the tab, choose the Search Console
   property for the site (`sc-domain:acme.example` or `https://acme.example/`). The list holds the properties your Google
   account can read. Repeat the choice on each site's SEO tab; the Google login is shared.

**Testing mode expires the login after 7 days.** An app whose publishing status is Testing gets a refresh token that
expires in 7 days ([Google, OAuth 2.0 token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
FounderData then marks Google as disconnected, shows Google's message in the SEO tab and keeps the stored numbers.
To avoid the weekly reconnect, set the publishing status to **In production** on the consent screen. An unverified app
in production shows Google's "unverified app" warning before consent and is limited to 100 new users
([Google, OAuth verification](https://support.google.com/cloud/answer/7454865)), which is plenty for one owner. A
refresh token also stops working when you revoke access in your Google account or leave it unused for six months.

Only an owner connects, picks a property or disconnects: the admin password, or a teammate with the owner role. A
viewer login, a phone token and an API key, also one with `seo:write`, get `403`.

The Google grant is one per deployment. FounderData records who connected it, "owner" for the admin password or the
teammate's name, and the SEO tab shows it. The sync reads that person's Search Console access, so if a teammate who
connected Google leaves, disconnect and connect again with your own login.

### What the Worker does

- **Token.** The refresh token is stored in `google_auth`, encrypted with AES-GCM (WebCrypto) under a key that HKDF
  derives from `SESSION_SECRET`, with a fresh IV per token. The database never holds the plain token. If you change
  `SESSION_SECRET`, the token can't be read, and the tab asks you to connect again. The scope is read-only
  (`webmasters.readonly`). The sign-in requests `access_type=offline` and `prompt=consent`, so Google returns a refresh
  token every time.
- **State.** The `state` of the sign-in is signed with `SESSION_SECRET` and tied to the owner's session cookie, and the
  same nonce travels in an HttpOnly cookie. A callback with a missing, changed, expired (10 minutes) or foreign state
  gets `400` and stores nothing.
- **When it runs.** On the `*/5 * * * *` cron the sync runs at minute 30 of every hour, so nothing else of the hourly
  jobs shares its invocation except the rank and AI checks. A deployment that kept the old `0 * * * *` cron runs it at
  minute 0 with everything else. Either way it draws on one subrequest budget that every job of the invocation shares
  (see [What fits the free plan](#what-fits-the-free-plan)).
- **Daily sync.** It adds each day Search Console has, ending 3 days before today. Search Console is sometimes later
  than that, so a day counts as stored only when Search Console returned data for it. When a newer day arrives, the sync
  also reads the last 3 stored days again and replaces them, so a day that was partial or missing when first read is
  corrected. A day with no data yet is looked at again the next day, not every hour. The tab shows the newest day
  stored, which can be earlier than 3 days ago. Per day it asks `searchAnalytics.query` for up to 250 queries (`dimensions: [date, query]`) and 250 pages
  (`[date, page]`). Search Console sorts by clicks, so the rest are the rows with the fewest. A day keeps the 40 with the
  most clicks and the 40 with the most impressions, so queries with impressions and no clicks stay for the opportunities
  view; rows past the 250 are not read. A `date` request over the missing range says which days have data. Once per new day it
  also asks for the page and query pairs of the last 28 days and the 28 before (`[page, query]`, 1,500 pairs a window).
  Google reads the dates as Pacific time.
- **Backfill.** The first runs go backwards from the newest day to 16 months ago, newest days first, until Search Console
  has nothing older. The tab shows how far it got.
- **Same format.** It writes `gsc_daily`, `gsc_queries`, `gsc_pages` and `gsc_page_queries`, and sets `property` and
  `gscThrough` and `gscSource: "oauth"` in `meta` ([Parts](#parts)). The dashboard, the read API and `get_seo` work unchanged. A site that has no
  `meta` gets one with empty targets and plan.
- **Revoked or invalid grant.** When Google answers `invalid_grant`, the cron stops, `google_auth` is marked
  disconnected and the SEO tab shows the error with a Connect Google button. A property Google refuses (403 or 404) is
  marked with its error and skipped until you pick it again. Other errors (a 429, a 5xx) show in the tab and the next
  run retries. A 401 from Search Console is asked once more before it counts as a refused grant, so one bad answer does
  not force a reconnect.
- **A push in between.** Every statement of a step checks the `pushed_at` of each part the step writes. When a script
  push or a second run changed one of them since the step read it, the whole step is skipped: no part, no cursor and no
  meta change. The next run reads the range from the stored part and goes on, so no day is stored twice and the parts
  keep the same days.

### What fits the free plan

A run spends at most 24 subrequests, D1 calls included, and never more than the shared budget of its invocation has
left. The free plan allows 50 subrequests for a whole scheduled invocation, and `scheduled()` gives every job one
shared counter (`src/worker/subrequests.ts`) that counts each D1 query and each outgoing call. The sync asks it before
it starts a day, and stops cleanly, with the cursor where it was, when the pool is short. A day starts only when the
budget still covers the writes after it: up to three cuts of a full part, the commit and an error row. It uses 1 for the
token refresh, 1 per probe, and 2 per day it fills (more when a response needs paging), so about 10 days a run, a few
fewer when the pool is shared with rank and AI checks. Each response holds up to 1,500 rows and pages with `startRow`; Search Console allows 25,000 at most. A
`GSC_REQUEST_ROWS` secret or variable (up to 25,000) and `GSC_PAGE_QUERY_ROWS` (up to 5,000 pairs a window) raise the
sizes on Workers Paid.

The Worker never parses a stored part. The sync adds a day's rows as text to the end of the stored array (new days) or
the start of it (older days) inside one SQL `UPDATE`, so a megabyte stays in D1. This keeps a run inside the free
plan's 10 ms of CPU. I did not measure CPU on Cloudflare itself. The step that reads 250 rows per day and dimension, and
the one that merges up to 3,000 page and query pairs, parse JSON in the Worker and are the likeliest to pass 10 ms.
If a run fails with a CPU error on the free plan, lower `GSC_PAGE_QUERY_ROWS` first.

Once a day, after the page and query pairs, the sync builds `gsc_page_totals`, then `gsc_query_totals` on a later run
([Search totals](#search-totals)). Each is 3 pulls of up to 1,500 rows, one request each. A totals step runs only in
a run that wrote nothing else, and the run ends after it, so it never shares a run with the day pulls, the pairs or
the backfill. The site stays due, and the next cron run goes on.

I timed the step on a Mac, not on Cloudflare. With 1,500 rows a pull it took about 3.7 ms of CPU for pages and 3.3 ms
for queries. With 3,000 rows a pull it took 7.6 ms and 6.3 ms, too close to the free plan's 10 ms, so 1,500 is the
default. `GSC_TOTALS_ROWS` raises it on Workers Paid. Each pull may take 5 responses, so the most it asks for is 5
times `GSC_REQUEST_ROWS`: 7,500 at the default 1,500 rows a response, 25,000 once `GSC_REQUEST_ROWS` is 5,000 or more.
A higher `GSC_TOTALS_ROWS` is cut to that.

D1 rows written: 4 for a backfill step of about 10 days (the three parts and the cursor row), and 7 on a day that also
rebuilds meta and the page and query pairs. Each totals part adds 2 a day (the part and the cursor row). A site's
first step writes 10, because a new part costs 2 rows with its primary key entry. A run with nothing to do writes 0.
See the cost table in the [README](../README.md#what-it-costs).

### Limits

- A part may hold 1.9 MB. A day keeps up to 80 queries and 80 pages (the top 40 by clicks and the top 40 by
  impressions, fewer when the two overlap). At about 65 bytes a row that is about 5 KB a day, so a busy site fills a
  part after about a year, and a quiet one holds the 16 months. I have not measured it on a real property. When a part
  reaches 1.9 MB, the sync cuts the oldest days and the backfill stops there.
- Only the 250 rows of a day with the most clicks are read, so on a site with more than 250 queries a day the
  zero-click queries beyond them are missing from the daily parts. Over 28 days, decay and opportunities read the
  totals parts instead, which hold every page and query up to 1,500 rows a window (`GSC_TOTALS_ROWS`). Other windows read partial sums
  from the daily parts. Search Console also leaves out rare queries, so all of them are lower bounds.
- `gsc_page_queries`, which the Cannibalization view reads, covers the last 28 days and the 28 before, and keeps 1,500
  pairs for the two windows together: the pairs with the most clicks. See [Cannibalization](#cannibalization).
- Search Console leaves out rare queries for privacy, so rows add up to less than the daily totals.
- The sync reads only compact JSON parts that start with a day. A part pushed pretty-printed by another tool is left
  alone and the tab shows an error. Push it again with the script, or delete the part.
- Changing a site's property deletes its stored `gsc_*` parts, because they hold the old property's numbers.
  **Stop syncing this site** keeps the stored data and stops new days. **Disconnect Google** asks Google to revoke the
  token and deletes it here; every site's stored data stays. The answer says whether Google confirmed the revoke
  (`revoked`). When it did not, or the stored token can't be read, the row is still deleted and the tab tells you to
  remove FounderData at myaccount.google.com/permissions.

### If the script also pushes

Both can run. A push replaces a whole part, so for every day a push contains, the pushed value wins. The sync never
rewrites a day inside the range a part already holds. It adds days outside it: newer days at the end and older days
at the start. It notices a push because the part's timestamp no longer matches the one it wrote, and then takes the
range from the part itself. A script window of 90 days therefore drops the older history until the sync backfills it
again, and the script's 5,000 page and query pairs stay until the sync adds a new day. If you want one source, remove
the other. The script remains supported for people who don't want OAuth.

## Sync Search Console

`scripts/gsc-sync.mjs` is the way without OAuth. It runs on your machine, pulls the last 90 days from the Search Console API and pushes `gsc_daily`, `gsc_queries` and
`gsc_pages`. It also pushes `gsc_page_queries`, the queries per page for the last 28 days and the 28 before, and
`gsc_page_totals` and `gsc_query_totals`, every page and query over the same windows ([Search totals](#search-totals)). Then it sets `property` and `gscThrough` in `meta`. Every other `meta` field (targets, plan, work, AI
answers) stays as it was, so another script can own those. It needs Node 20 or later and no packages.

### Google access

Pick one of the two.

**A service account.** This suits a script that runs every day.

1. In Google Cloud, create a project, enable the **Google Search Console API**, and create a service account.
2. Create a JSON key for it and save the file as `~/.config/founderdata/gsc-credentials.json` (`chmod 600`).
3. In Search Console, open the property, then **Settings > Users and permissions**, and add the service account's
   email (`...@....iam.gserviceaccount.com`) with **Restricted** permission. Reading needs nothing more.

**An OAuth refresh token.** Use this when you can't add users to the property. Create an OAuth client of type
Desktop app, get a refresh token for the scope `https://www.googleapis.com/auth/webmasters.readonly` (the OAuth
Playground works), and save `{ "client_id": "...", "client_secret": "...", "refresh_token": "..." }` as
`~/.config/founderdata/gsc-credentials.json`. The variables `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET` and
`GSC_REFRESH_TOKEN` work too.

The script also reads the admin password from `~/.config/founderdata/admin-password`, the file `npm run setup` writes.
To run it without the password, pass a key with `seo:write` as `--key-file <file>` or in `FOUNDERDATA_KEY`. A key
with only `read` can't push a snapshot.

### Run it

```bash
node scripts/gsc-sync.mjs --url https://founderdata.example.com --site SITE_ID --property sc-domain:acme.example
```

The property is `sc-domain:acme.example` for a domain property, or `https://acme.example/` with the trailing slash
for a URL prefix. The site id is in the site's settings. For several sites, write
`~/.config/founderdata/gsc-sync.json` and run the script with no arguments:

```json
{
  "url": "https://founderdata.example.com",
  "days": 90,
  "sites": [
    { "site": "SITE_ID", "property": "sc-domain:acme.example" },
    { "site": "OTHER_SITE_ID", "property": "https://blog.acme.example/" }
  ]
}
```

Each run prints rows, days and kilobytes per part. Search Console reports about 2 days late, so the window ends 2 days
before today. Page URLs become paths (`https://acme.example/blog/x?ref=1` is `/blog/x`), so they match the entry pages
FounderData counts.

A second run with the same data writes nothing. The script compares each part with the stored one and skips the push
when they match. It pushes `meta` only when a part, the property or `gscThrough` changed. A day's run writes at most
10 D1 rows, 2 per part.

| Option | Default | What it does |
| --- | --- | --- |
| `--days <n>` | 90 | days to pull, 1 to 480 (Search Console keeps 16 months) |
| `--config <file>` | `~/.config/founderdata/gsc-sync.json` | the sites to sync; `--site` picks one of them |
| `--credentials <file>` | `~/.config/founderdata/gsc-credentials.json` | the service account key or OAuth file |
| `--password-file <file>` | `~/.config/founderdata/admin-password` | the admin password, or set `FOUNDERDATA_PASSWORD` |
| `--max-rows <n>` | 200,000 | rows pulled per part |
| `--dry-run` | off | pull and print, push nothing |

A part may hold 1.9 MB. A large site can pass that with queries, so the script drops whole queries or pages, the least
clicked first, and prints how many it dropped. A kept query keeps all its days, so decay stays correct.
`gsc_page_queries` keeps the 5,000 page and query pairs with the most clicks over both windows, about 500 KB. It pulls
up to 25,000 pairs per window first, and `--max-rows` doesn't change that.

The exit code is 1 when a site failed. A 403 means the property doesn't list the service account as a user, or the API
is off in its Google Cloud project.

### Schedule it

On a Mac, copy `scripts/gsc-sync.plist.example` to `~/Library/LaunchAgents/com.example.founderdata-gsc.plist`, replace
the node path and the clone path, then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.founderdata-gsc.plist
launchctl kickstart gui/$(id -u)/com.example.founderdata-gsc   # run once now
```

It reads the sites from `~/.config/founderdata/gsc-sync.json`. On Linux, use a cron line:

```cron
30 7 * * * cd /path/to/founderdata && /usr/bin/node scripts/gsc-sync.mjs >> /tmp/gsc-sync.log 2>&1
```

## Parts

The TypeScript types in [`pro/dashboard/lib/seo.ts`](../pro/dashboard/lib/seo.ts) are the format. In short:

| Part | Type | Shape |
| --- | --- | --- |
| `gsc_daily` | `GscDay[]` | `[date, clicks, impressions, position]` per day, `date` as `YYYY-MM-DD`, oldest day first |
| `gsc_queries` | `GscRow[]` | `[date, query, clicks, impressions, position]` per day and query |
| `gsc_pages` | `GscRow[]` | `[date, page, clicks, impressions, position]` per day and page, as a URL or a path |
| `gsc_page_queries` | `GscPageQueries` | the queries per page over two fixed windows, below; optional |
| `gsc_page_totals` | `GscTotals` | every page over 28 days, the 28 before and the last 7; optional. See [Search totals](#search-totals) |
| `gsc_query_totals` | `GscTotals` | every query over the same windows; optional |
| `site_inventory` | `SiteInventory` | your crawler's last run, one row per URL; optional. See [Page audit](#page-audit) |
| `meta` | `SeoMeta` | everything else, below |

`position` may be `null`. Rows are per day so the tab can sum any window from 7 days to 12 months. Sort every
per-day part by date, oldest first. Home, the portfolio and the `site_google_*` alert rules read only the end of
`gsc_daily`, and they skip a part whose end is not in date order.

`gsc_page_queries` answers which queries bring a page its clicks. Per-day rows of every page and query would pass the
part's size limit, so this part has no day column. It holds two windows: `from` to `to`, and `previousFrom` to
`previousTo` right before, 28 days each. The sync ends them on the last day in `gsc_daily`.

```json
{
  "from": "2026-10-06", "to": "2026-11-02", "previousFrom": "2026-09-08", "previousTo": "2026-10-05",
  "rows": [
    ["/blog/stripe-vs-paddle", "stripe vs paddle", 12, 159, 6.6, 31, 208, 4.6],
    ["/blog/stripe-vs-paddle", "paddle merchant of record", 3, 89, 7.8, 0, 73, 8.8]
  ]
}
```

Each row is `[page, query, clicks, impressions, position, previous clicks, previous impressions, previous position]`.
A pair with no impressions in a window has `0, 0, null` there. The page is a URL or a path, as in `gsc_pages`. Keep it
to 5,000 rows, the most clicked over both windows first. Search Console hides rare queries, so a page's rows add up to
fewer clicks than its `gsc_pages` rows. The Content tab's page detail lists the rows as "Queries for this page", and the
Content list counts them per page. `GET /api/v1/content/page` answers them as `search.queries`.

`meta` fields, all present, `null` or `[]` when you have nothing for them:

- `version` (1), `project` (any slug), `name`, `domain`, `status`, `generatedAt` (ISO time), `property` (the Search
  Console property), `gscThrough` (the last day Search Console has data for; the tab ends every window there).
- `targets`: keywords you track, each with `term`, `role`, `market`, an optional `page`, `volume` and the latest `serp`
  check (your position and whether an AI Overview cites you).
- `plan`: an SEO plan as packages with a state (`done`, `in-progress`, `blocked`, `external`), progress and next step.
- `work`: a ship log of changes (`kind` is `edit`, `new`, `offsite` or `release`).
- `lane`, `portfolioFocus`, `focusWeekday`: what an SEO automation may do on the site. The Approach card shows only
  when one of these or `work` is set.
- `aiPanel`: prompts you asked AI assistants and whether they mentioned the site. The tab shows the latest run.
  To keep the history, push each check to `POST /api/v1/ai-answers` as well ([API.md](API.md#ai-answer-checks)).
- `serpCompetitors`: who ranks for your terms instead.
- `backlinks`: domain rating and backlink counts.

## Decay and opportunities

The SEO tab computes these in the browser. The read API computes the same numbers with the same code
(`src/shared/seo-insights.ts`), so an agent and the tab agree.

A **decaying page** had at least 10 Search Console clicks in the 28 days before the last 28, and lost more than 30%
of them in the last 28. The 28 days end on `gscThrough`, or on the last day in `gsc_pages`. A page with no row in the
last 28 days lost all its clicks. Pages are sorted by clicks lost. Revenue at risk is the revenue of visits that came
from a search engine and entered on the page in the last 28 days, matched by path: Search Console's
`https://acme.example/blog/x` is the entry page `/blog/x`. The SEO tab shows the pages under the SEO plan, with
clicks per week over 8 weeks.

An **opportunity** is one of two things, each ranked by clicks to gain:

- A query close to page one: an average position of 5 to 20 and at least 20 impressions in 28 days. Clicks to gain
  are the clicks the query would get at position 3 at the usual click-through rate, minus the clicks it had.
- A page on page one (position 10 or better) with at least 50 impressions in 28 days and less than half the usual
  click-through rate for its position. Clicks to gain are the clicks at the usual rate, minus the clicks it had.

The usual rate is a rough curve from public CTR studies: 28% at position 1, 15% at 2, 11% at 3, down to 2.2% at 10
and 1% on page two. Use it to find pages far below it, not as a target. Both minimums scale with the window: 7 days
needs 5 and 13 impressions.

Two read key routes return these lists. Both are documented in [API.md](API.md#get-apiv1seodecay):

```bash
curl -H "Authorization: Bearer rtr_..." "$BASE/api/v1/seo/decay?limit=5"
curl -H "Authorization: Bearer rtr_..." "$BASE/api/v1/seo/opportunities?days=28&limit=5"
```

They parse the snapshot in the Worker, unlike the tab. Each reads only `meta` and the rows it needs, and the answer is
cached for 60 seconds per key. A snapshot near the 1.9 MB limit may still take more than the free plan's 10 ms of CPU
on a cache miss.

Each opportunity row says whether Google still shows it, and what to edit:

- `impressions_7d`: impressions in the last 7 days of the window. A row drops out only when the data proves it had
  none, because a new title will not bring back a page Google stopped showing. `dropped_no_recent_impressions` counts
  those rows.
- The proof depends on the source. With the totals parts, the recent pull must have stayed under its row cap
  (`recentComplete`). With the daily parts, each of the last 7 days must hold fewer than 40 rows, because the sync
  keeps the top 40 of a day by clicks and the top 40 by impressions, and a busier day may have cut the row. Without
  that proof the row stays with `impressions_7d` `null`. `recent_complete` in the answer says which list had it.
- On the daily source a number in `impressions_7d` can be low, because a day may have cut the row.
- `last_impression_day`: the last day the daily parts have impressions for it. `null` when it was never in a day's
  top 80; `impressions_7d` still says whether it shows.
- On a query: `page`, the page that showed most for it in `gsc_page_queries`, with its `page_position`.
- `title` and `meta_description` of that page from the latest crawl (`site_inventory`), when the crawler sends
  `metaDescription`. `crawl_observed_at` is the crawl's day.

### Search totals

The daily parts keep each day's top 80 queries and pages, so a page outside them on most days looks smaller than it is,
or flickers in and out. `gsc_page_totals` and `gsc_query_totals` hold every page (or query) Search Console reports
for three windows, from one pull each with no day dimension:

```json
{
  "from": "2026-10-06", "to": "2026-11-02", "previousFrom": "2026-09-08", "previousTo": "2026-10-05",
  "recentFrom": "2026-10-27", "complete": true, "recentComplete": true,
  "rows": [
    ["/blog/stripe-vs-paddle", 41, 1210, 6.2, 63, 1405, 4.9, 9, 260],
    ["/pricing", 30, 410, 2.1, 28, 380, 2.3, 7, 101]
  ]
}
```

Each row is `[key, clicks, impressions, position, previous clicks, previous impressions, previous position, recent
clicks, recent impressions]`. The key is a path in `gsc_page_totals` and a query in `gsc_query_totals`. The recent
numbers cover `recentFrom` to `to`, the last 7 days. `complete` is `false` when a pull stopped at its row cap, so the
least clicked keys of that window are missing. `recentComplete` is `false` when the recent pull was one of them. Then a
key with 0 recent impressions may still show on Google, and opportunities keep it. Both flags are optional, and a part
without them counts as cut. The sync builds both once a day for the newest day; the script builds
them on every run.

Decay, the 28-day opportunities, the `page_decay` alert rule and the weekly report's search line read these parts when
their `to` is within 2 days of `gscThrough`. The answers say which they used: `source` on decay, `queries_source` and
`pages_source` on opportunities (`totals` or `daily`). Other windows and the charts keep the daily parts.

## Search drop

Decay looks at pages one by one, so a collapse spread over many small pages can show as "4 pages losing clicks". The
search drop looks at the whole site's `gsc_daily` instead. It finds the one day in the last 98 where the daily level
changed most (least squares) and reports it when all of these hold:

- the level after is at least 50% under the 28 days before it (60% while the drop is under 7 days old, so a weekend
  does not count);
- the level before had at least 20 impressions a day (or 3 clicks, when only clicks fell);
- the drop is 4 to 56 days old on the last Search Console day, and the last 3 days are still that low;
- the 3 days before it were still high and its first day was already low.

A collapse that never recovers shows for 8 weeks. After that the lower level counts as the site's normal and
nothing shows. Nothing shows either when the last Search Console day is more than 14 days old: the sync stopped, so
the drop is not news. Each answer names `since`, the levels per
day before and after, and the average position on both sides. A sudden site-wide drop with a position move usually
comes from a redirect, a canonical tag, a robots rule or a domain change, so check those before you rewrite pages.

It shows on Home under "Worth a look" (kind `search_drop`), in `get_portfolio` alerts, at the top of the SEO tab, as
`search_drop` in `get_seo` summary and the decay answer. Home reads only the last 6 KB of each site's `gsc_daily`. For
a webhook, add an alert rule on `site_google_impressions` or `site_google_clicks`, such as "falls 50% in 7 days"
([API.md](API.md#alert-rules)).

## Cannibalization

The SEO tab's Cannibalization view lists queries where two or more of your pages compete. It reads `gsc_page_queries`,
so it needs no new data, and covers that part's last 28 days whatever window the tab shows. A query is flagged when at
least two pages each have 10% or more of the query's impressions and 20 or more impressions. The shares count only the
page and query pairs stored in `gsc_page_queries`, also the ones below the bar. The sync keeps 1,500 pairs for the 28
days and the 28 before together, the ones with the most clicks. A query whose pages had few clicks can be missing or
understated, and zero-click pairs are where cannibalization often sits, so read an empty list as "none among the kept
pairs". `pairs_kept` in the API answer says how many pairs the part holds. Pages are matched by path, so on a
`sc-domain:` property two subdomains with the same path count as one page. For each page it shows the position, clicks and
impressions, and the share of impressions and clicks. Most impressions first.

`GET /api/v1/seo/cannibalization` and `get_seo` with `view: "cannibalization"` return the same list, from the same code
(`src/shared/seo-insights.ts`). They parse the part in the Worker and cache the answer for 60 seconds. Both bars are
in the answer as `min_share` and `min_impressions`. See [API.md](API.md#get-apiv1seocannibalization).

Two pages sharing a query is a lead, not a verdict. Different intents, a category page above a product page, or a
branded query can all look the same. Check the queries before you merge or redirect anything.

## Page audit

FounderData doesn't crawl your site either. Run your own crawler, then push its last run as the `site_inventory` part,
one row per URL. The SEO tab's Page audit view and `GET /api/v1/seo/audit` flag the problems. The types are in
[`src/shared/site-audit.ts`](../src/shared/site-audit.ts), which both run.

```json
{
  "version": 1,
  "observedAt": "2026-11-05",
  "source": "my-crawler 1.2",
  "pages": [
    {
      "url": "https://acme.example/blog/stripe-vs-paddle",
      "status": 200,
      "finalUrl": null,
      "title": "Stripe vs Paddle for a SaaS in 2026",
      "titleLength": 34,
      "metaDescriptionLength": 148,
      "canonical": "https://acme.example/blog/stripe-vs-paddle",
      "indexable": true,
      "schemaTypes": ["Article", "BreadcrumbList"],
      "wordCount": 1840,
      "linksIn": 7,
      "linksOut": 23,
      "observed": "2026-11-05"
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | string | The URL as crawled, or a path. The audit shows it as a path, like the other parts |
| `status` | integer or `null` | The HTTP status without following redirects. `null` when the fetch failed |
| `finalUrl` | string or `null` | Where a redirect ended. Optional |
| `title` | string or `null` | The page title as served |
| `titleLength` | integer or `null` | Characters in the title. Optional; without it the audit counts `title` |
| `metaDescriptionLength` | integer or `null` | Characters in the meta description, `0` when there is none |
| `metaDescription` | string or `null` | The meta description itself. Optional; SEO opportunities show it beside the page |
| `canonical` | string or `null` | The canonical URL the page names |
| `indexable` | boolean or `null` | `false` when a robots meta tag or `X-Robots-Tag` header says `noindex` |
| `schemaTypes` | string[] | The JSON-LD `@type` values on the page, `[]` for none |
| `wordCount` | integer or `null` | Words of visible text |
| `linksIn` | integer or `null` | Internal links to this URL from the other crawled pages |
| `linksOut` | integer or `null` | Internal links on the page |
| `observed` | `YYYY-MM-DD` | The day the crawler fetched the URL |

`null` means the crawler did not measure it, and the audit treats it that way: a check never flags a `null` field,
and the URL counts under `not_measured` for that check. A URL with `status` `null` is not measured at all. It gets no
flag and counts under `not_fetched`. Send real zeros only for real zeros. A crawler that doesn't count incoming links
sends `linksIn: null`, so no page shows as orphaned.

The flags:

| Flag | When |
| --- | --- |
| `non_200` | `status` is anything other than 200, a redirect included |
| `noindex` | a 200 page with `indexable: false` |
| `missing_meta` | a 200 page with `metaDescriptionLength: 0` |
| `title_too_long` | a 200 page whose title has more than 60 characters, where Google usually cuts it |
| `thin` | a 200 page with fewer than 300 words |
| `orphaned` | a 200 page with `linksIn: 0` |

A push replaces the part. Keep one crawl in it, at most about 5,000 URLs, to stay under the 1.9 MB part limit. The API
caches its answer for 60 seconds per key, so a fresh push can take a minute to show there.

A crawl older than 30 days is stale: the pages may have changed since. The audit answer says `age_days` and `stale`,
counted from `observedAt` (or from the push without one), and adds a note when it is stale. The Page audit view says
so in its header. Crawl again before you fix flags from a stale crawl.


## Keyword research and rank tracking

FounderData can check where your site ranks on Google, once a day, and find keywords worth tracking. It does this on
your own [DataForSEO](https://dataforseo.com) account. You pay DataForSEO directly and FounderData adds no charge.
Everything here is optional. Without the two secrets below the SEO tab's Google ranks view explains the setup, the
cron makes no call, and nothing is written.

### Set it up

1. In DataForSEO, find your API login and API password. The API password is a different string from your account
   password. Add some balance to the account.
2. Add both to the Worker as secrets and deploy again:

   ```bash
   node scripts/wrangler.mjs secret put DATAFORSEO_LOGIN
   node scripts/wrangler.mjs secret put DATAFORSEO_PASSWORD
   npm run setup
   ```

3. Open the SEO tab, Google ranks. Pick the country, device and monthly cap, then add keywords, one per line, or import a CSV (the
   `keyword` column, or the first one). You can also add them from the keyword research box. A site holds 200.
4. The daily check of every keyword posts at the first cron run from 05:00 UTC. A keyword that was never checked is posted at
   the next run at any hour, so a new keyword has its first rank within about 15 minutes. The cron runs every 5 minutes, so
   the results arrive on the runs after that, a few minutes later. Before 05:00 UTC only never-checked keywords post, and the
   day is not marked done, so the 05:00 check still covers the rest. If DataForSEO refuses the country's location or language
   code, the Ranks settings and the [setup checklist](GUIDE.md#setup-checklist) show its message until you pick another country. Adding keywords ends a hold after a failed post, but only a hold older than 5 minutes, so a script that adds one keyword a minute cannot force a retry at every tick.

One DataForSEO account serves every site. Each site has its own keywords, country and cap.

### What a check is

The cron posts one SERP Standard task per keyword (`serp/google/organic/task_post`), all keywords of a site in one
call. DataForSEO charges when it sets the task. On later runs the Worker asks `tasks_ready` and reads the
finished ones with `task_get`. It stores, per keyword and UTC day:

- `position`, the site's best organic result on its domain or a subdomain, 1 being the top. `null` means the site is
  not in the first `depth` results.
- `url`, the page that ranks.
- `aio`, whether an AI Overview showed, and `aio_cited`, whether it links to the site. These are `null` unless you
  turn on the AI Overview setting or one came back in the results. See the cost note below.

A keyword is never posted twice for the same UTC day. Before the paid call, the Worker claims the keywords with one
D1 update that marks them `pending` for the day, so a retry, a slow run or a second overlapping run finds the day
taken. After the call, the task ids replace the marker. If the call times out or fails after DataForSEO may have
charged for it, the claim stays until the next UTC day: you lose one day of checks and never pay twice. A refusal
that cannot have been charged (a wrong login, no funds, an error with no cost) releases the claim, and the site tries
again at the first run of the next hour, not at every run. A keyword whose check is still open, because nobody collected the result yet, is not posted
again until it is collected or 3 days old. A keyword you remove and add back keeps its check for 3 days, so it is not
paid twice. FounderData does not use DataForSEO's postback URL: collecting
with `tasks_ready` needs no public endpoint on your Worker, and a result that arrives late just waits for the next run.

The same check also stores the SERP around the rank, on the same row (migration 0068):

- `serp_top`, the first 10 organic results as `[rank, domain, url]`;
- `serp_features`, the item types the page showed besides organic results (`featured_snippet`, `people_also_ask`,
  `video`, `discussions_and_forums`, `local_pack`, `images`, `ai_overview` and others), the domain the featured snippet
  quotes, and up to 5 People also ask questions.

SERP titles and snippets are written by strangers, so the Worker never stores them. The Ranks table shows the keyword
you typed, the latest position, the change against the check 7 and 30 days earlier (up is better), a 30 day trend, the
AI Overview flags and the ranking page. With a Search Console snapshot it also shows clicks for the same query over the
window the tab uses.

### SERP competitors

`get_seo` with `view: "competitors"`, or `GET /api/v1/ranks/competitors`, reads `serp_top` of each tracked keyword's
latest check (at most 10 days old). Per domain it answers the keywords it is in the top 10 for, its average position,
its slots and its share of all top-10 slots, the SERP share of voice. The change compares the same keywords with their
check 7 to 10 days earlier, so a keyword added this week does not count as a gain. `you` is your own domain's row,
`features` counts the keywords whose page shows each feature, and `snippet_owners` lists who holds featured snippets.

With `keyword`, it answers that keyword's top 10 with each domain's rank 7 days before (`null` for a newcomer), the
domains that dropped out, the features, the snippet owner and the People also ask questions. That answers "who took
my spot this week" without buying research. It costs nothing: the daily check already paid for the whole page. Checks
from before migration 0068 have no SERP, so the view fills up from the first check after it.

### Research

Keyword research has two questions, and both cost DataForSEO's Labs price per call.

- Find keywords takes a seed term and returns suggestions with search volume and difficulty (0 to 100).
- What it ranks for takes a domain, yours by default, and returns the keywords it ranks for with the position and page.

Each row has a Track button. A bought answer goes into the research log as a `keywords` entry, tagged with the
question, valid for 30 days. Asking the same question again, from the dashboard or an agent, reads the log and costs
nothing. Buy fresh data on purpose with the Buy fresh data link, or `refresh: true`. The log keeps 4,000 characters
per entry, so a cached answer holds the first rows that fit and says `truncated`.

### Cost

DataForSEO returns the price of every call in `cost`, in US dollars. FounderData adds it to a counter per site and
month and shows it as "spent this month". Every DataForSEO price in these docs, the dashboard and the README is an
unverified estimate. Nobody has checked it against DataForSEO's price list, and no source or date is recorded. The
list is the authority, and your own first batch shows the real figure.

| Keywords, one check a day | Top 10 results | Top 20 results |
| --- | --- | --- |
| 50 | about $0.90 a month | about $1.80 a month |
| 100 | about $1.80 a month | about $3.60 a month |
| 200 | about $3.60 a month | about $7.20 a month |

These numbers assume $0.0006 for a Standard SERP of 10 results and double that for 20, so a daily check costs
$0.0006 to $0.0012. They leave the AI Overview setting out. It adds about $0.002 a check in DataForSEO's documentation,
which makes a check $0.0026 to $0.0032 and the table this:

| Keywords, one check a day, AI Overview on | Top 10 results | Top 20 results |
| --- | --- | --- |
| 50 | about $3.90 a month | about $4.80 a month |
| 100 | about $7.80 a month | about $9.60 a month |
| 200 | about $15.60 a month | about $19.20 a month |

Research is billed per call.
DataForSEO's documentation shows $0.0101 for a one-row keyword suggestion call, and a call that returns 50 rows costs
more, so read `cost_usd` in the answer. DataForSEO asks for a prepaid balance. Its minimum is on its pricing page.

The monthly cap defaults to $10 for a site, which pays for 200 keywords at 20 results ($7.20) with room for research.
With the AI Overview setting on, those 200 keywords cost about $19.20, and the $10 default is reached around day 15 of the
month. The Settings box suggests a cap that includes the setting: $25 for 200 keywords at 20 results with it on. At
depth 100, 200 keywords cost about $36 a month, so the Settings box suggests a cap for your keyword count and depth.
You set it there, from $0 to $1,000. The Worker sizes each batch from the larger of what the month's checks have cost
so far and a floor for the current depth and AI Overview setting, and posts only the keywords the remaining cap pays
for. Research refuses a call when the month's spend plus the call's expected cost ($0.01 plus $0.0001 a row) would pass
the cap. The cap is soft: two runs that overlap can each size a batch from the same spend, and a price change at
DataForSEO shows up only after a call. At the cap, posting and research stop, and the Ranks view says so. The cap is per
site. The counter is FounderData's record of the `cost` values it saw, so DataForSEO's own balance is the final
authority. Only the dashboard login can change the cap. An agent key can spend within it, not raise it.

### Limits

- 200 keywords per site. 200 checks a day write about 600 D1 rows a day: 200 to claim the keywords, 200 to save the
  task ids and 200 for the results, plus 1 or 2 for the spend counter. That is 0.6% of the free plan's 100,000. One call
  posts at most 100 checks, so 200 keywords post in two calls. A run makes at most 4 task_post calls in all, Google and
  App Store together, so the day's posts take a few runs of the 5-minute cron.
- The free plan gives a scheduled run 10 ms of CPU too, shared with the AI runner in the same invocation, and 50
  subrequests. Each result is a JSON document the Worker parses. Parsing a 100-result SERP of about 100 KB took
  0.4 ms on an M-series Mac (pro/test/ranks.test.ts), so a run collects 6 results, counted as 6 task_get calls whether or not
  the task has finished. The cron runs every 5 minutes, 288 runs a day, so Free collects 6 x 288 = 1,728 results a day
  across all sites and across Google and App Store ranks. That covers 200 keywords and 720 App Store pairs (920 a day)
  with room left. A deployment that kept the hourly cron in `wrangler.local.jsonc` collects 144 a day, about 140
  keywords, until it adds `*/5 * * * *`. On Workers Paid, a run has 30 seconds of CPU: set the `RANK_COLLECT_PER_RUN`
  variable (1 to 100). At 100 a run, 28,800 results a day cover the 200 keywords of 144 sites. The Ranks settings show
  the daily capacity and the keywords tracked across all sites. Results stay with DataForSEO for 30 days. Collection takes
  the sites in turn, within the oldest 200 open checks of each site, so one big site cannot starve the others. A check
  that waits is never posted twice. The per-result time is an estimate from that one parse, not a measurement inside Workers.
- Posting is sized by collection. The Worker keeps no more checks open than a day collects times 2, across Google and App
  Store checks (3,456 on Free), so a check is never dropped unread. A list that passes it waits.
- A check that has not come back after 3 days is dropped, and the next day posts a new one.
- Days are UTC days. A keyword gets one check a day. Tracking pauses with the Run the daily checks box.
- Rank history is kept for 400 days.
- The position is the first one on the site's domain in the results DataForSEO returned for the country, language and
  device you picked. It can differ from what you see in your own browser, which is personalised.

### App Store ranks

The same DataForSEO account checks App Store ranks for iOS apps, daily, without a collector on your Mac. It shares the
login, the spend counter and the monthly cap with this page. See [ASO.md](ASO.md#ranks-without-your-mac).

### Through the API and MCP

Agents read ranks with `get_seo` and `view: "ranks"`, or `GET /api/v1/ranks`. Each row names the latest check's
`serp_features` and `snippet_owner`. `view: "competitors"` reads who holds the top 10 ([SERP competitors](#serp-competitors)). A key with `research:write` can track keywords (up to 200 a
request) with the MCP tool `research_keywords` and `track`, or `POST /api/v1/ranks/keywords`. Buying research with
`mode`, or `POST /api/v1/ranks/research`, spends your DataForSEO money and needs the `spend:seo` scope, which
`research:write` does not include.
The tool checks the research log first, so an agent never buys the same answer twice. [API.md](API.md#ranks-and-keyword-research)
has the request and answer shapes, and [MCP.md](MCP.md) the tools.
