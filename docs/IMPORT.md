# Import web history

Plausible lets you export your history as a zip of CSV files. FounderData reads that zip (Plausible's export format; other tools that export the same CSV files work too, but only Plausible's is tested) and shows
the days in the main chart and in the top panels, so a site that moved over keeps its past traffic.

## What an import does

- The chart, the top numbers (visitors, pageviews, bounce rate, visit duration) and the panels for sources, campaigns,
  keywords, pages, entry pages, exit pages, countries, devices, browsers, operating systems and goals include the
  imported days.
- Imported days show only before the site's first visit recorded by FounderData. On a day that has both, FounderData's
  own data counts and the imported row is ignored, so nothing is counted twice. Days of the import from that date on stay
  stored but are not shown.
- The first day is the oldest visit still in the database, not a stored date. Erasing the visitor behind the oldest
  visit, or retention deleting old visits (`RETENTION_MONTHS`, 24 by default), moves it later. Imported days between
  the old and the new date then show again, and the visits that were there are gone, so no day counts twice.
- Revenue, customers, conversion rate, subscriptions and visitor journeys use FounderData's own data only. An imported
  day has no visits to link a payment to, so its revenue is 0. Home, the iPhone app, alerts and the weekly report also
  use own data only. The one exception is opt-in and sits on the chart only: [Include imported history](#include-imported-history). Imported revenue also stops the day before FounderData's first payment, when that is earlier than its first visit, so a day never shows both.
- A filter on one dimension, such as `source = X`, a country or a page, is answered from that panel's imported rows:
  visitors, pageviews and the chart for the matching label, with no visits, bounce rate or duration. A source filter
  also carries the imported revenue of that source. Two filters at once, or a panel the import does not have, show no
  imported day, because an imported day has no visits to cross-filter. The chart shades the days that come from an
  import and the hover card says "Imported".
- Visitors are summed per day. A person who came on 3 days is 3 visitors in an imported range, and 1 in a range of own
  data.

## Import from the dashboard

1. In Plausible, open the site's settings, then Imports and exports, then Export data. The zip arrives by email.
2. In FounderData, open the site's Settings, then Import history, and choose the zip. Choosing the CSV files from an
   unzipped export works too.
3. The page reads the files in your browser and shows the days, the visitors and pageviews, and how many database rows
   the import stores. Select **Import** to send them.
4. Keep the page open until the import is done. When the daily allowance runs out (see "What it costs"), the import
   pauses and **Resume** continues it. The import counts in the stats once it is finished.
   After a reload, an unfinished import shows how many day-rows are stored and **Resume with the same file**. Choose
   the same export again: the page skips the chunks already stored and sends the rest. A different file, or one that
   covers other days, is refused.

An import you do not want goes with **Delete**. Two imports of one site cannot overlap in days, and a site has at most
10.

Files read: `imported_visitors`, `imported_sources`, `imported_pages`, `imported_entry_pages`,
`imported_exit_pages`, `imported_locations`, `imported_devices`, `imported_browsers`, `imported_operating_systems` and
`imported_custom_events`. Custom events become goals, and outbound link and download events are skipped. Custom properties are ignored. A
file is recognized by its columns, not its name. Without `imported_visitors` the panels still fill, but the chart and
the top numbers get no imported days.

Per day and panel, the 1,000 labels with the most visitors are kept. Countries are two-letter codes. A visit with no
source is stored as the empty label and shows as the same "none" row as direct visits.

## What it costs

Each stored day-row is one D1 row written, with no secondary index. A day with every panel holds up to 12 rows, so a year
of history is about 4,400 rows. The import has its own allowance of 20,000 rows a UTC day for the whole
deployment (`IMPORT_DAILY_ROWS`), separate from the tracker's write cap, so an import cannot make the tracker drop
events. That is 20% of the free plan's 100,000 rows. When a chunk would pass the allowance the Worker answers `429` and
the import can resume after 00:00 UTC. A start costs 3 rows. Each chunk adds 1 row for the allowance counter. A delete costs 1 row per stored row plus 1 for the
import. Reading adds one indexed lookup per request on a site without an import, and 1 or 2 more queries on a site with one.

## API

All routes need the dashboard login (admin password). The dashboard parses the CSV files itself, so the Worker only
takes aggregates, which keeps each request under the free plan's 10 ms of CPU.

| Route | What it does |
| --- | --- |
| `GET /api/sites/:id/imports` | `{ imports, native_from, allowance: { used, limit, resets_at }, max_chunk_rows, max_chunk_bytes }`. `native_from` is the first day with own data, or `null`. An unfinished import also carries `stored`, its day-rows so far. |
| `POST /api/sites/:id/imports` | Body `{ "source": "plausible" or "datafast", "from": "2025-01-01", "to": "2025-12-31", "files": [{ "name", "table", "rows" }] }`. Answers `{ "id" }`. `409` when the days overlap another import. |
| `POST /api/sites/:id/imports/:iid/rows` | Body `{ "rows": [{ "kind", "day", "data" }] }`, at most 100 rows and 400 KB. Sending a row again replaces it. `429` past the daily allowance. |
| `GET /api/sites/:id/imports/:iid/progress` | `{ keys }`: the `kind|day` rows stored so far. A DataFast run that was cut off reads it to skip what is done. |
| `POST /api/sites/:id/imports/datafast/get` | Body `{ "key", "path", "query" }`. Forwards one GET to `https://datafa.st/api/v1/<path>` for the browser when DataFast blocks its direct calls. Only `analytics/` timeseries, metadata and the seven breakdowns. The key is used for that call and not stored or logged. |
| `POST /api/sites/:id/imports/:iid/finish` | Makes the import count. `400` when no row was stored. |
| `DELETE /api/sites/:id/imports/:iid` | Deletes the import and its rows. |

A row's `day` is `YYYY-MM-DD` in the site's timezone, inside the import's `from` and `to`. `kind` is `visitors` or a panel
(`source`, `campaign`, `keyword`, `page`, `entry_page`, `exit_page`, `country`, `device`, `browser`, `os`, `goal`), or, from DataFast, `revenue` and `source_revenue`.
For `visitors`, `data` is `{ "v": visitors, "p": pageviews, "s": visits, "b": bounced visits, "d": total visit seconds }`.
For a panel, `data` maps a label to `[visitors, pageviews]`, up to 1,000 labels. DataFast days add `"n": 1` to `visitors` data
(then `b` and `d` may be left out): the tool has no bounces or visit seconds, so those days stay out of bounce rate and
duration. `revenue` data is `{ "r": minor units, "n": payments }`, `source_revenue` maps a label to `[minor units, payments]`.

`src/shared/plausible-import.ts` turns the CSV files into these rows. A script can call it, or write the rows from any
other source, as long as the numbers are daily totals.

Reads show where imported days are. `GET /api/v1/stats/overview` returns `imported: { from, to, days }` (or `null`; with revenue from a DataFast import it adds `revenue` in minor units and `payments`, for a key that shows revenue; they never join `revenue`), and
`GET /api/v1/stats/timeseries` marks each point that holds imported days with `imported: true`. Both also carry `native_from`, the first day with FounderData's own data (the seam), when the range reaches it, and with a revenue key each point that has imported revenue carries `imported_revenue` in minor units, apart from `revenue`. The MCP tools
`get_overview`, `get_timeseries` and `get_breakdown` carry the same fields and say so in their descriptions.
`GET /api/v1/stats/breakdown` includes imported days like the dashboard panels do, with 0 revenue on them. A `source` row over imported DataFast days adds `imported_revenue` and `imported_payments` (minor units; only for a key that shows revenue), apart from `revenue`.

## Where the data lives

Two tables from migration 0038: `imports` (one row per import) and `imported_daily` (one row per site, kind, day and
import). Deleting the site deletes both. See [PRIVACY.md](PRIVACY.md): the rows are aggregates with no visitor id.

## Import from DataFast

DataFast has no export file ([its terms](https://datafa.st/tos) say it provides no archive exports or raw event logs), but it has a
REST API with day totals and breakdowns. In Settings, Import history, **Import from DataFast** reads that API from your
browser.

1. In DataFast, create a website API key (`df_...`), or an account token (`dft_...`) with `analytics:read`, which also needs the
   website id.
2. Paste the key, pick the days and **Weekly** or **Daily** breakdowns, and choose how DataFast writes revenue: whole
   currency units, cents, or leave revenue out. There is no default, and Start stays off until you choose. If DataFast's
   metadata does not name its currency, tick the box that confirms it is the site's currency. Start the import and keep
   the page open. It shows progress and the time left.
3. After a reload, an unfinished import shows **Resume**. Paste the key again (it is never stored) and the page skips
   the days already stored.

**The key.** The browser sends it to `https://datafa.st/api/v1/` as `Authorization: Bearer <key>`. If DataFast blocks
browser calls (CORS), the page forwards each call through `POST /api/sites/:id/imports/datafast/get`, one page per request,
so the key then also passes through your Worker. The Worker passes it on for that call and does not store, cache or log it.

**What is read.** One `timeseries` call per 900 days for daily visitors, pageviews, sessions, revenue and payments. Then,
for each day or week with visitors, seven breakdowns at `limit=1000`, paged with `offset`: `referrers` (sources),
`pages`, `countries`, `devices`, `browsers`, `operating-systems` and `campaigns`. Days with no visitors cost nothing.
DataFast's limit is 60 calls a minute, so the page waits 1.05 s between calls and 60 s (or `Retry-After`) after a 429.

**Daily or weekly.** Breakdowns take one start and end date and no interval, so a daily breakdown is one call per day and
panel. Over 14 months that is up to about 3,000 calls, about 50 minutes. Weekly buckets are about 430 calls, about 7
minutes. In weekly mode the panels hold a week as one row on its first day. A date range that starts inside a week leaves that
week out; one that ends inside a week counts all of it. A filtered chart shows a week's visitors on one day. Day totals and the unfiltered chart stay daily either way.
Visitors in both modes are summed over the buckets, so a person who came on two days counts twice.

**What is stored.** Per day or week: sources (known names map to FounderData's, so `t.co` is **X** and `Direct / None` is the
direct row), pages (the path), countries (names become ISO codes), devices, browsers, operating systems and campaigns.
DataFast has no pageviews per row, so those panels show visitors. It has no entry pages, exit pages, keywords or goals,
and no bounce rate or visit duration per day; those stay out.

**Revenue.** DataFast reports revenue per day and per source. It is stored as imported revenue and shown labelled: on a
source row's hover card, and as `imported.revenue` in the overview. It is never added to the revenue, customers or
conversion of your own data, which stay native. The only place the two meet is the chart's opt-in
[Include imported history](#include-imported-history) line, which draws them together and labels the seam. A share link, a read key or a scoped key without revenue access gets
neither the per-source nor the overview figure. DataFast's docs show revenue as plain numbers without naming the unit,
and the import will not guess: the form asks for the unit and refuses to start until you choose. It compares DataFast's
currency (`analytics/metadata`) with the site's and leaves revenue out when they differ; when DataFast names no currency,
you confirm it. It also compares DataFast's timezone with the site's and warns when they differ, because day totals
can then sit one day off. Compare one source with your DataFast dashboard and redo the import if it was wrong.

### Include imported history

The chart on Overview has a checkbox, off by default, when the range holds imported revenue.
Tick it and the revenue strip becomes one line: each day or week is native revenue plus imported revenue, with a dashed
vertical marker labelled "Native data starts" on the first day FounderData recorded itself. The hover card then splits
the day into "Native revenue" and "Imported revenue". Nothing else changes. The revenue tile stays native and shows a
"native only" label while the box is ticked, and a line under the key says how much imported revenue the line adds.
Customers, conversion rate, revenue per visitor, Home, the iPhone app, alerts and reports stay native, because an imported
day has no customers and no visits to attribute. Only DataFast imports carry revenue, so a Plausible-only site has no
checkbox. The marker needs the range to reach the first native day. A range that ends before it shows imported days only,
and one that starts after it shows no imported days. Imported revenue is in the currency you confirmed at import time,
which the import checks against the site's. A filter on a source draws that source's imported revenue the same way.

**No double counting.** As with Plausible, an imported day counts only before the site's first visit recorded by
FounderData. The import enforces it for weekly buckets: it stops the day before that first visit, so the last week is a
shorter bucket that ends there and no imported day overlaps native data. If the site's first visit comes later than
you thought, delete the import and run it again.

**Filters.** Filtering by a source answers from the imported days: `source = X` over the old range gives its visitors, its
chart and its imported revenue.

**Cost.** 1 D1 row written per stored day-row. A day with traffic stores up to 9 rows in daily mode (totals, revenue and the
panels), a week up to 8. 14 months daily is about 2,500 to 4,000 rows against the 20,000-row daily allowance, weekly
about 600.
