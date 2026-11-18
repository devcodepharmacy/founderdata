# ASO

The ASO tab shows where an iOS app ranks in App Store search for the keywords you pick, in each country you pick. It
also shows the 10 apps above it, a difficulty score, Apple's search popularity, ratings per country and new reviews.
It is on every site with a bundle id, and it stays a setup guide until the first snapshot arrives.

This is a FounderData Pro feature ([PRO.md](PRO.md)). In core, the tab shows the Pro card.

## Read this first: Apple's terms

Ranks, the top 10, ratings and reviews come from App Store endpoints that Apple doesn't document for this use:

- the store search, `search.itunes.apple.com/WebObjects/MZStore.woa/wa/search`
- the lookup, `itunes.apple.com/lookup`
- the customer reviews feed, `itunes.apple.com/<country>/rss/customerreviews/...`

Apple's website terms forbid automated access to its sites, and the `robots.txt` of these hosts disallows these
paths. FounderData doesn't run the collector for you. [Ranks without your Mac](#ranks-without-your-mac) avoids these endpoints
for ranks. If you run it, you do so on your own machine, under your own
name, at your own risk. You decide.

The collector keeps the volume low and doesn't hide what it is:

- one search per keyword and country a run, and one run a day is enough
- 3 seconds between two requests to the same host
- at most 300 requests a run
- a user agent that names FounderData
- after a 403 or 429 it leaves that host alone for 6 hours
- no proxies, no rotating addresses

Popularity is different. It comes from the Apple Ads Platform API, which Apple offers for exactly this. Keyword
suggestions come from Apple's search hints, the same request the App Store search box makes as you type.

## Why a collector

Apple answers 403 to the search, lookup and review endpoints when the request comes from Cloudflare's network. We
tested it on 2026-11-02 from a Worker, from three Cloudflare locations, and every request that wasn't in Apple's cache
failed within 7 ms. The same requests from a home connection got 200. The documented iTunes Search API answered 429,
because every Worker on Cloudflare shares the same addresses.

So the Worker never calls these endpoints. A small script, `scripts/aso-collect.mjs`, runs on a machine Apple does
answer, such as your Mac, a home server or a cheap VPS. It reads what to check from your deployment, asks Apple and
posts what it found. It is plain Node 20 with no dependencies.

## Ranks without your Mac

If you have a DataForSEO account, it can check the ranks for you. Nothing runs on your machine, and the Worker sends no
request to Apple's search endpoints. The collector stays as the free option.

**The terms note.** The collector reads Apple endpoints that Apple's terms don't allow automated access to. Ranks
without your Mac come from DataForSEO's [App Data API](https://docs.dataforseo.com/v3/app_data-apple-overview/), a
licensed product you pay for with your own account. Ratings and reviews still need the collector.

**Turn it on.**

1. Add `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` as Worker secrets, the same two that [rank tracking](SEO.md#keyword-research-and-rank-tracking)
   uses. The API password is not your account password.
2. Make sure the app has its App Store id (Settings, or the first collector snapshot stores it).
3. In the ASO tab, open **Ranks without your Mac** and check the estimate. The monthly cap is the site's and is shared with
   Google rank tracking and keyword research. When yours is lower than the suggested cap, the button reads **Turn on and
   raise the cap to $X** and the text above it says so. Set the cap yourself first if you want to keep a lower one. The
   plain **Turn on** never changes the cap. Only the dashboard login turns it on or changes the cap. A key with `aso:write` can't.

**What it checks.** Every keyword in every country of the app, at a depth of 100 results, once a UTC day when the
deployment can collect that many results. On Free it collects up to 1,728 results a day, shared with Google rank
tracking, so 720 pairs get a new rank every day. More pairs than the day collects wait their turn: a list of 3,456 pairs
gets a new rank about every 2 days. One check is one task:

| Call | Endpoint |
| --- | --- |
| Post the checks, up to 100 a call | `POST /v3/app_data/apple/app_searches/task_post` |
| Which are ready, every run | `GET /v3/app_data/apple/app_searches/tasks_ready` |
| Collect one result | `GET /v3/app_data/apple/app_searches/task_get/advanced/{id}` |

The answer lists the apps in the App Store search for the keyword. FounderData stores the app's place, the places of your
competitors, the number of results, and the top 10 with name, rating count and average. The App Data answer has no
subtitle or release day, so those are empty in the top 10, and the difficulty score leans on the rating count and the
name match. Sources: [task_post](https://docs.dataforseo.com/v3/app_data-apple-app_searches-task_post/) and
[task_get](https://docs.dataforseo.com/v3/app_data-apple-app_searches-task_get-advanced/), read on 2026-11-09. The
`tasks_ready` page was not reachable then. FounderData reads it like every DataForSEO task API, as a list of task ids.

**Coverage.** DataForSEO's Apple locations are countries only (`GET /v3/app_data/apple/locations`, 105 in its sample).
The Worker maps 50 of the 52 App Store countries FounderData tracks to a location code and a language. Russia is not
supported by DataForSEO, and China and Taiwan are left out because no Chinese language code was confirmed. Those
countries stay with the collector, and the tab says so. The location codes and languages are unverified against the live
list. If DataForSEO refuses the checks of a country, the tab shows its message for that country, and the Worker leaves
that country alone until the next UTC day. It does not try the same pairs at every run.

**Cadence and day one.** The cron runs every 5 minutes. Each pair is checked once a UTC day, from 05:00 UTC. A pair that
was never checked is posted at the next run, at any hour, so a keyword you add, import or switch on gets its first rank the same day
when the cap allows. A daily trend follows from the next day. A run posts at most 4 task_post calls across all apps and
Google keywords, and at most 2 of them (200 checks) for one app, so 720 pairs are posted over 4 runs, about 15
minutes. Posting is sized by what the day collects: the Worker keeps no more checks open than the deployment collects
in 2 days (3,456 on Free). A check that has not come back after 3 days is dropped, and sizing keeps that from
happening to a check you paid for. The pairs past that limit show as queued and post as results come back.

**Never twice.** Before a call, the cron claims its pairs in one write, and an overlapping run or a retry finds them
taken. A pair with an open check is never posted again, and a timeout keeps the claim until the next UTC day. Removing a
keyword and adding it back the same day costs nothing. A refusal of the whole call that cannot have been charged (login,
no funds) releases the claim, and the site tries again at the first run of the next hour, not at every run. When
DataForSEO refuses single tasks, for example a wrong language code, those pairs count as checked for the day with its
message, and a country whose every pair was refused is skipped until tomorrow.

**When both give a rank.** A snapshot row holds one rank per keyword, country and day, and each rank has a source:
`dataforseo`, `import` or the collector. With hosted ranks on, DataForSEO's rank for a pair wins. A collector push drops
the keywords that DataForSEO already ranked that day and stores the rest. If the collector posts first, DataForSEO's
check later the same day replaces its rank. With hosted ranks off, the collector replaces anything. An imported rank
never replaces either. The tab shows the source, and `GET /api/sites/:id/aso` has it in `latest.<country>.rankSource`.

**What it costs.** DataForSEO bills per task and per 100 results. The documentation shows $0.0024 for a 200-result
task, and the price page was not readable, so FounderData estimates $0.0012 per check at 100 results and plans with
$0.0024 until the month has real charges to average. [SEO.md](SEO.md#cost) says how far to trust these prices. At the estimate:

| Pairs a day | A month at $0.0012 | A month at $0.0024 | Suggested cap |
| --- | --- | --- | --- |
| 100 | $3.60 | $7.20 | $6 |
| 240 | $8.64 | $17.28 | $12 |
| 720 | $25.92 | $51.84 | $34 |

The suggested cap is the estimate for 30 days plus 25% and $1 for keyword reads. The spend counter and cap are the
site's, shared with Google rank tracking and research, so one cap limits all three. The cap is soft: a call that would
pass it isn't made, but overlapping runs can overshoot it a little, and the tab says how many checks wait.

**What fits the free plan.** A cron run has 10 ms of CPU and 50 subrequests on Free, and every result is parsed JSON. A
run collects at most 6 results (6 task_get calls, whether or not the task is ready), shared between Google ranks and App
Store ranks, and the two take turns going first. The cron runs every 5 minutes, 288 times a day, so Free collects
up to 1,728 results a day. That covers 720 pairs and 200 Google keywords (920 a day) with room left, and about 1,700 pairs
in all. A test runs a day of ticks for 720 pairs, 200 keywords and 150 AI checks: the busiest tick made 40 subrequests
(DataForSEO calls, engine calls and D1 queries together) of Free's 50. The hourly jobs run on their own ticks (minute 0 pushes
and alert rules, minute 15 X, minute 30 Search Console), and every job of one run draws on one counter that stops a paid call
unless the writes that record it also fit. Set `RANK_COLLECT_PER_RUN` (1 to 100) on Workers
Paid, which has 30 s of CPU a run: 30 collects 8,640 results a day and 100 collects 28,800. A deployment that kept the
old hourly cron in `wrangler.local.jsonc` collects 6 x 24 = 144 a day until you add `*/5 * * * *` there. D1 rows
written for 720 pairs a day are about 3,100 (4 per pair, 1 of them the entry in the open-task index, plus the snapshot rows and counters), 2.4% of Free's 100,000
daily writes. A tick with nothing to do writes none. It reads about 3,000 rows at this size, so the ticks of a day read
about 1 million of Free's 5 million. The per-write numbers are in [What it costs](#what-it-costs).

**Keywords this app already ranks for.** The button under the keyword box reads
`POST /v3/dataforseo_labs/apple/keywords_for_app/live` and lists the keywords the app ranks for with its rank and Apple search volume,
for you to tick and add. It covers the US App Store and English only, and DataForSEO refreshes it weekly. A read of
100 keywords costs about $0.02. It is saved in the research log for 30 days, so reading again is free, and it counts against the monthly cap.
Agents use `research_keywords` with `mode: "app"` ([MCP.md](MCP.md)), which needs `spend:seo`.

## Set it up

This section sets up the collector.

1. **Add keywords.** Open the app's ASO tab. Pick up to 10 countries and add up to 200 keywords, 1,000 checks in all
   ([Limits](#limits)). The first country is a guess from where the app's sessions come from, the US when there are none.
   Apple's search suggestions appear as you type. Each keyword is checked in every country. Coming from Astro or
   Appfigures? [Import your keywords](#import-keywords) instead of typing them.
2. **Run the probe** on the machine that will run the collector, from a clone of this repository:

   ```bash
   node scripts/aso-collect.mjs --probe
   ```

   It makes 8 requests, one search, one hints request, one lookup and one review page each for the US and Germany,
   and prints a table:

   ```text
   Endpoint  Country  Status  Results  Size    Time
   --------  -------  ------  -------  ------  -------
   search    us       200     249      105 KB  1726 ms
   hints     us       200     10       3 KB    1590 ms
   lookup    us       200     1        11 KB   1061 ms
   reviews   us       200     50       40 KB   2284 ms
   ...
   Apple answers this machine. You can schedule the collector here.
   ```

   `--country us,jp` and `--term "pdf scanner"` change what it checks. It exits with 1 when a request failed.
3. **Run it once:**

   ```bash
   node scripts/aso-collect.mjs https://founderdata.example.com
   ```

   It signs in with the admin password from `~/.config/founderdata/admin-password`, the file `npm run setup` writes.
   Set `FOUNDERDATA_PASSWORD` or pass `--password-file <file>` on another machine. To run it without the password,
   make a key with the `aso:write` scope in Settings, Agents and pass it with `--key-file <file>` or in
   `FOUNDERDATA_KEY`; the collector then checks only the sites the key covers. It prints a line per app and
   country and the number of requests it made. The tab switches on with the first snapshot.
4. **Schedule it** once a day, below.

Options:

| Option | Default | What it does |
| --- | --- | --- |
| `--site <id>` | every app with keywords | only this site |
| `--dry-run` | off | ask Apple and print the table, post nothing |
| `--gap <seconds>` | 3 | seconds between two requests to one host, at least 1 |
| `--max-requests <n>` | 300 | requests to Apple per run |
| `--reviews-only` | off | read new reviews only, one request per app and country, and post them. Checks no ranks |
| `--review-pages <n>` | 10 | review pages per app and country, 50 reviews each, 1 to 10 |
| `--ignore-pause` | off | ask a host that answered 403 or 429 in the last 6 hours anyway |

A run costs one search per keyword and country, one lookup per country, and one to ten review pages per country. The
first run reads up to 10 pages, and later runs stop at the first review they already have. 20 keywords in 2 countries
take about 50 requests and 3 minutes.

At 300 requests a run, an app with more keyword and country pairs than that is checked over several runs. The
collector remembers when it last checked each pair in `~/.config/founderdata/aso-collector.json` and checks the pairs
checked longest ago first. Without that file, as on a GitHub Actions runner, the list rotates by the day. 1,000 pairs
take 4 daily runs, so each keyword gets a new rank every 4 days. Raise `--max-requests` to check more in a run, at
3 seconds a request. The collector posts the snapshot in chunks of 50 keywords, which merge into one row for the day. The pauses are kept in `~/.config/founderdata/aso-collector.json`. The exit code
is 2 when Apple refused a host during the run.

## Schedule it

### macOS: launchd

Copy `scripts/aso-collect.plist.example` to `~/Library/LaunchAgents/com.example.founderdata-aso.plist`, replace the
paths and the URL, then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.founderdata-aso.plist
launchctl kickstart gui/$(id -u)/com.example.founderdata-aso   # run once now
```

It runs at 06:15 local time. A Mac that was asleep runs it when it wakes. `which node` gives the path to Node.

### Linux: cron

```cron
15 6 * * * cd /path/to/founderdata && /usr/bin/node scripts/aso-collect.mjs https://founderdata.example.com >> /tmp/aso-collect.log 2>&1
```

### GitHub Actions

Cloud runners send from shared data center addresses, like Cloudflare. Apple may refuse them the same way, so run the
probe there first: push the workflow with only the `--probe` step, run it by hand and read its log. Only schedule it
when every row says 200.

```yaml
# .github/workflows/aso-collect.yml in a private repository with a copy of scripts/aso-collect.mjs
name: ASO collector
on:
  schedule: [{ cron: '15 6 * * *' }]
  workflow_dispatch:
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/aso-collect.mjs --probe
      - run: node scripts/aso-collect.mjs https://founderdata.example.com
        env:
          FOUNDERDATA_PASSWORD: ${{ secrets.FOUNDERDATA_PASSWORD }}
```

A runner starts fresh each time, so the 6-hour pause after a 403 doesn't carry over between runs there.

## Import keywords

The ASO tab has **Import keywords from a file** under the keyword box. Pick a file or paste the text. The tab shows how
many keywords it found, how many it adds, how many are already tracked and how many are over the limit. Nothing is
saved until you press Import.

It reads:

- **An Astro export.** Export a keyword list from Astro as CSV. FounderData uses the `Keyword` column and the country
  in `Store Domain` (`us`, `de`). If the export holds several apps, the tab asks which app to take, and it offers this
  app's id first. The `App Id` and `App Name` columns tell the apps apart.
- **Another CSV with a header.** The keyword column is named `Keyword`, `Keywords`, `Term`, `Search term` or `Query`. An
  optional country column is named `Country`, `Storefront`, `Region` or `Locale`, with a code (`de`) or a name
  (`Germany`). Comma, semicolon and tab all work. This covers an Appfigures export, whose keyword and country columns
  carry these names.
- **A plain list.** One keyword per line, or keywords separated by commas on one line. `keyword,country` lines work
  too.

A `Ranking` (or `Rank`) column is read as the rank on the day of the export and stored as today's rank for that
keyword and country, with the source `import`. A row with a blank, `-` or `0` rank has no rank to store. A file without a
country column has none to place a rank in, so it imports keywords only. The first hosted or collector check of the day
replaces an imported rank, and an import never overwrites a rank that is already there. Popularity, difficulty, notes and
tags in the file are not imported. FounderData takes popularity from Apple Ads and works difficulty out from the top 10,
so the numbers would not match. Keywords are lowercased and cut to single spaces, like the ones you type.

Every keyword is checked in every country of the app. A file that names countries can add them: tick **Also track the
countries in the file**, and the countries not yet tracked are added, up to the limit.

The import report has four numbers:

| Number | Meaning |
| --- | --- |
| Added | Keywords stored. 1 D1 row each |
| Skipped as duplicates | Repeats inside the file, and keywords the app already tracks |
| Over the limit | Keywords left out because the app is full. The first ones in the file are kept |
| Empty or too long | Rows with no keyword or more than 100 characters |
| Ranks | Ranks from the file stored as today's, 1 D1 row per country |

## Review alerts

When the collector posts a new written review of 3 stars or fewer, FounderData sends it to:

- every alert channel with **Low App Store review** on in Notifications: Slack, Discord, Telegram, a webhook or email,
  for the channels that cover this app
- every phone with alert push on that hasn't muted this app, through the same APNs setup as payment alerts. The `APNS_*`
  secrets in [GUIDE.md](GUIDE.md#phone-app-and-push-pro) switch it on, and it has no switch of its own in the phone's event list

Change the limit and switch it off per app in the ASO tab, under **Review alerts**, or with `reviewAlert` in
`PUT /api/sites/:id/aso/settings`. The default is on, at 3 stars. Without a settings row an app uses the default.

Rules:

- A review alerts once. A review FounderData already stored never alerts again.
- A review written more than 3 days ago doesn't alert. The first run of the collector reads up to 500 old reviews and
  would otherwise send a message for each.
- One post alerts once. It names up to 3 reviews, worst first, and counts the rest.
- An alert shows the stars, the app version, the review title and up to 300 characters of its text.
- The review text is written by a stranger. It is sent as plain text with control and direction characters removed.
  Slack and email escape it, and Discord messages can't ping anyone. The alert runs after the response and writes no
  D1 row.

The collector reads reviews when it runs, so a daily run alerts within a day. To hear about a bad review sooner, add a
second schedule that runs `node scripts/aso-collect.mjs https://founderdata.example.com --reviews-only` every hour. It
makes one request per app and country and checks no ranks.

## Where each number comes from

| Column | Source |
| --- | --- |
| Rank | The app's place among the ids in the store search answer, about 250 of them. "none" means it wasn't among them |
| 1 day, 7 days | The latest rank against the reading of the day before, and the reading 7 days before. Up arrows mean the app moved up |
| Best | The best rank in the last 90 days |
| Popularity | Apple Ads, `searchPopularity1to100` for the last Sunday to Saturday week. "low" means Apple publishes no score |
| Difficulty | Worked out in the browser from the top 10, below |
| 30 days | The rank on each day with a snapshot. A gap is a day the app wasn't in the results |
| Top 10 | Name, subtitle, rating count and average rating from the search answer. Apple includes them for about the first 8. The lookup fills in places 9 and 10, without a subtitle |
| Ratings | The lookup: Apple's average and count per country, for the app and its competitors |
| Reviews | The reviews feed, newest first. Apple serves the newest 500 per country, reviews with text only |

The table has one row per keyword, with the countries as column groups: rank and 7-day move, popularity and difficulty
for each. **Every country row** switches to one row per keyword and country with all the columns above, and the
choice stays in the browser. Click a keyword for its top 10 and its rank history in each country.

Results move by 1 or 2 places between two requests a few minutes apart, and the iPhone App Store can differ from this
answer because of ads and personalization. Read the trend over days, not a single day's move.

### Difficulty

Difficulty is a score from 0 to 100 for how hard the top 10 is to break into. It is worked out in the browser from
the last top 10 of each keyword (`dashboard/lib/aso.ts` in the Pro repository):

- 60% from the median rating count of the 10 apps, on a log scale. 100,000 ratings or more counts in full.
- 30% from how many of them have every word of the keyword in their name or subtitle.
- 10% from their mean rating. 3.5 stars or less counts as 0, 5 stars in full.

It needs rating counts for at least 3 of the 10 apps. Apple and the paid ASO tools use their own formulas, so their
scores and this one won't match.

The bar under the score shows its band: green under 50 (easy), amber from 50 to 74 (medium), red from 75 (hard).

### Popularity

The Worker asks the Apple Ads Platform API for `POST /v1/insights/apps/search-term-popularity/query` once a week, on
the 07:00 UTC cron from Tuesday on, for every tracked keyword in every tracked country. Apple publishes a week on the
Monday after it. It needs the same four `ASA_*` secrets as the [Apple Search Ads import](GUIDE.md#apple-search-ads-pro),
and `ASA_AD_ACCOUNT_ID` or an API user with at least one ad account.

Apple has no score for a term with fewer than 500 searches that week, and the tab shows "low" for it. If Apple answers
403, the API user's role doesn't cover insights. The tab then says so, and the next run tries again. Apple hasn't
documented which roles may call it. API Account Manager is the one to try after API Read Only.

## Competitors

Add up to 5 competitors by their App Store id, the number in their App Store link. Their ranks come from the same
search answers, so they cost no extra request, and their ratings come from the same lookup. Clicking a keyword shows
where each competitor ranks.

A competitor's App Store title and subtitle come from the same search answers. Apple sends a subtitle for about the
first 8 results, so a competitor that is in no top 10 of a country has no subtitle there, and its title comes from the
lookup. FounderData keeps nothing else from a competitor's page: no description, no keyword field, no screenshots.

## Health and alerts

A status line at the top of the tab shows when the last snapshot arrived. Its (i) lists what each source answered per
country. A source paused after a 403 or 429 shows in red, in full, because the collector has stopped asking it. Requests
that failed or were skipped in the last run, such as 3 searches skipped, are a small amber chip instead.
The numbers for them stay at the last good reading and the next run tries again. The chip can be dismissed, and it comes
back with the next snapshot that has a problem.

The same line shows where popularity stands: the week of the stored scores, a failed check, or not set up. When the
`ASA_*` secrets are gone but scores from an earlier week are stored, it shows that week and says the weekly check is off.

When an app with keywords gets no collector snapshot for 36 hours, the daily 07:00 UTC cron sends **ASO collector
stopped** to every alert channel that has it on, once per outage. Channels from before this alert existed get it too.
The tab shows the same state in red. Only snapshots from the collector count. DataForSEO ranks and imports do not, so a
running hosted check never hides a dead collector, and an app that only uses hosted ranks never gets this alert. The tab
shows a stalled hosted check in the hosted status, as its error line.

## Limits

- 200 keywords, 10 countries and 5 competitors per app, and 1,000 keyword and country pairs in all. 200 keywords fit in
  5 countries, 10 countries fit 100 keywords. Adding past the limit keeps what fits and counts the rest.
- A keyword file is read up to 60 KB, about 400 rows of an Astro export or 5,000 short keywords. Longer files get a 400 answer, and you import them in parts. The cap keeps the parse under 5 ms of the free plan's 10 ms.
- Snapshots are capped at 256 KB, reviews at 100 per request. The collector posts 50 keywords at a time, about 70 KB.
- The tab keeps 90 days of ranks. Older snapshots stay in the database.
- Reviews are the ones with text. A rating without text only shows in the count.
- Ranks are for the iPhone App Store search with no account signed in, without ads.

## What it costs

Measured by a cost test in the Pro repository:

| Write | D1 rows |
| --- | --- |
| A snapshot, one app in one country, any number of keywords | 1, plus 1 the first time the app's id is stored |
| A second snapshot on the same day | 1, merged keyword by keyword |
| Reviews | 1 per new review, 0 for one already stored |
| Adding keywords | 1 per keyword, plus 1 for the settings row the first time |
| Countries or competitors | 1 |
| Popularity, once a week | 1 per keyword and country, plus 1 status row |
| Hosted ranks: a daily check posted / collected | 2 / 1 per pair (the claim and task id, then the cleared task), 1 per call for the cost counter and 1 snapshot row per country and run |
| Hosted ranks: ranks imported from a file | 1 per country |

3 apps with 30 keywords in 3 countries write 9 snapshot rows a day, the new reviews and about 39 popularity rows a day
averaged over the week. That is under 100 rows a day, 0.1% of the free plan. A snapshot of 30 keywords is about 40 KB.
Checking and rebuilding the largest one, 50 keywords with 10 apps each, took 0.6 ms of CPU on an M-series Mac, well
inside the free plan's 10 ms a request.

Why 1,000 pairs and not 200 keywords in 10 countries, which is 2,000. The newest top 10 of each pair is about 1.3 KB,
so the tab's answer would hold 2.6 MB of top 10s, plus the rank history. A phone token or the viewer login has that
answer parsed to hide secrets, which costs CPU in proportion to its size. At 1,000 pairs the answer is about 1.3 MB for
the top 10s, and the rank history covers `40,000 / pairs` days, at most 90 and at least 7. 50 keywords in 5 countries
(250 pairs) keep 90 days. 1,000 pairs show 40 days. The collector's 300 requests a run set the other bound: 1,000 pairs take 4 runs.

An app with more than 500 pairs must ask `GET /api/v1/aso/keywords` for one country at a time (`?country=de`), because
rebuilding every country's top 10 in one request costs about 2 ms of CPU per country of 200 keywords.

## API

All routes take the dashboard login. A phone token or the viewer login may read them. The collector posts with the
admin login, or with a scoped key that has `aso:write`. That key reaches `GET /api/aso/collect` (only its sites) and
the keywords, settings, snapshot and reviews writes below, nothing else ([API.md](API.md#seo-and-aso-writes)). A key
without the scope gets `403`. The read answer is in [MOBILE-API.md](MOBILE-API.md#6-aso).

A read key gets the same answer from `GET /api/v1/aso`, and `?changed_since=YYYY-MM-DD` keeps the keywords whose rank
moved. `GET /api/v1/aso/keywords?changed_since=&country=` answers one row per keyword and country, with the rank
change, popularity, difficulty and each competitor's rank, title and subtitle. Both are in
[API.md](API.md#get-apiv1asokeywords-pro). The MCP tool `get_aso` takes `changed_since` too. The review text is at
`GET /api/v1/aso/reviews` with a `read` key, and in `get_aso` with `reviews: true`, with `author` always `null`
([API.md](API.md#get-apiv1asoreviews-pro)).

| Route | What it does |
| --- | --- |
| `GET /api/sites/:id/aso?days=` | Everything the tab shows, ranks for the last `days` days, 7 to 90, see MOBILE-API.md |
| `POST /api/sites/:id/aso/keywords` | `{ "keywords": ["habit tracker", ...] }` adds keywords, or a comma-separated string. Answers `{ ok, added, keywords, report }`. `{ "csv": "<file text>" }` imports a keyword file, below |
| `DELETE /api/sites/:id/aso/keywords?keyword=...` | stops tracking one |
| `PUT /api/sites/:id/aso/hosted` | `{ "enabled": true, "monthly_cap_usd": 34 }`, either. Turns hosted ranks on or off and sets the site's monthly DataForSEO cap. `enabled` alone never changes the cap. Saving the cap on a site that has Google keywords but no rank settings row does not start Google checks. The login only, not an `aso:write` key. Answers the `hosted` status below |
| `POST /api/sites/:id/aso/app-keywords` | `{ "limit": 100, "refresh": false }`. The keywords the app ranks for in the US store, with `position`, `search_volume` and `tracked`. Spends from the cap, cached 30 days |
| `POST /api/v1/aso/app-keywords` | The same for an agent key with `spend:seo` |
| `PUT /api/sites/:id/aso/settings` | `{ "countries": ["us", "de"], "competitors": ["123456789"], "reviewAlert": { "on": true, "stars": 3 } }`, any of them. `stars` is 1 to 5 |
| `GET /api/sites/:id/aso/suggest?term=&country=` | `{ terms, error }` from Apple's search hints |
| `GET /api/sites/:id/aso/reviews?country=&stars=&offset=&limit=` | reviews newest first, 50 a page, `X-Next-Offset` when there are more |
| `GET /api/aso/collect` | what the collector checks: each site with keywords, its `appId`, `countries` with storefront ids, `keywords`, `competitors` and `newestReview` per country |
| `POST /api/sites/:id/aso/snapshot` | one snapshot, below |
| `POST /api/sites/:id/aso/reviews` | `{ "country": "us", "reviews": [{ "id", "at", "rating", "title", "body", "author", "version" }] }`, up to 100. `at` is ms or an ISO time |

### Importing keywords over the API

`POST /api/sites/:id/aso/keywords` takes the text of a file as `csv`, up to 60 KB. A key with `aso:write` may call it.

```bash
curl -X POST https://founderdata.example.com/api/sites/SITE_ID/aso/keywords \
  -H "Authorization: Bearer $FOUNDERDATA_KEY" -H 'content-type: application/json' \
  -d "$(jq -Rs '{csv: ., appId: "123456789", addCountries: true}' astro-export.csv)"
```

| Field | What it does |
| --- | --- |
| `csv` | the file text: an Astro export, a CSV with a keyword column, or one keyword per line |
| `appId` | the App Store id to take from an export with several apps. Without it, an export with more than one app answers 400 and lists them in `apps` |
| `addCountries` | `true` also tracks the countries named in the file, up to the limit |
| `dryRun` | `true` reads and counts and stores nothing |

The answer:

```json
{
  "ok": true,
  "dryRun": false,
  "added": ["habit tracker", "daily planner"],
  "keywords": 42,
  "report": {
    "read": 60, "added": 2, "alreadyTracked": 40, "duplicates": 18, "overLimit": 0, "limit": 200,
    "countries": ["us", "de"], "countriesAdded": ["de"], "countriesOverLimit": 0,
    "format": "astro", "apps": [], "appId": "123456789", "otherApps": 0, "invalid": 0,
    "unknownCountries": [], "ignoredColumns": ["popularity", "difficulty", "ranking"]
  }
}
```

`limit` is the keywords this app may track in its current countries, 200 or fewer. A file with only keywords that
don't fit answers 400.

### The snapshot

```json
{
  "v": 1,
  "country": "us",
  "collectedAt": 1793700000000,
  "appId": "123456789",
  "keywords": [
    {
      "keyword": "habit tracker",
      "rank": 14,
      "results": 249,
      "competitors": { "987654321": 3 },
      "top": [["987654321", "Name", "Subtitle", 98279, 4.5, "2015-06-02"]]
    }
  ],
  "ratings": [["123456789", "Name", 1234, 4.7, "2.4.0"]],
  "sources": { "search": { "ok": 30, "failed": 0, "skipped": 0, "status": 200, "retryAfter": null, "paused": false } },
  "collector": "aso-collect/1"
}
```

- `rank` is 1-based, or `null` when the app wasn't in the results. A keyword the collector couldn't check is left out,
  so it never reads as "not ranked".
- `top` holds up to 10 apps as `[id, name, subtitle, rating count, average rating, release day]`. Unknown values are
  `null`.
- `ratings` rows are `[app id, name, rating count, average rating, version]`.
- `sources` has `search`, `lookup` and `reviews`. `status` is the last HTTP status, `retryAfter` Apple's Retry-After in
  seconds, `paused` true when the collector skipped the host after an earlier 403 or 429.
- `collectedAt` must be within the last 7 days. Its UTC day is the snapshot's day.
- `country` must be one of the app's countries. Keywords the app doesn't track and competitors it doesn't have are
  dropped, and texts are cut to 100 characters.

The Worker rebuilds the snapshot from these fields and stores it as text in `aso_snapshots`
(`migrations/0024_aso.sql`), one row per app, country and day. A second snapshot on the same day merges into it
keyword by keyword, so a run Apple stopped halfway doesn't erase what an earlier run found. The read answer splices
the stored text in without parsing it.
