# AI visibility

AI visibility answers one question: when someone asks an AI engine for a product like yours, does it name you, who
does it name instead, and which pages does it cite? FounderData asks the engines itself, with your own API keys, and
keeps every answer in the same history that [AI answer checks](API.md#ai-answer-checks-pro) use.

This is a FounderData Pro feature ([PRO.md](PRO.md)).

Two parts work apart from each other:

1. **The prompt runner.** You save prompts, names and competitors. The cron asks the engines you turn on and
   stores the answers.
2. **AI crawler hits.** Your server forwards requests from GPTBot, ClaudeBot, PerplexityBot and the others, because
   crawlers don't run the tracker's JavaScript.

Everything is optional. With no prompts, no engine key and no forwarder, the tab shows what to set up next.

## What the numbers are

The runner calls each engine's API with web search on. That is a model with a search tool, not a replay of what
chatgpt.com, claude.ai or Google show. Answers differ by account, location and day. The mention rate is a sample of
how the model answers over many days. One day is noise; the trend is the signal.

| Number | How it is counted |
| --- | --- |
| Mention rate | Checks whose answer contains one of your brand names, over all checks. Per engine, per prompt and per day |
| Your site cited | Checks that cite a URL on your domain or its subdomains, over all checks |
| Position | The order of first appearance among all tracked names (brands and competitors) in the answer. 1 is named first. A brand that is not named has no position |
| Share of voice | A name's answers over all name mentions, across every brand and competitor |
| Most cited | Domains and URLs in the answers' citations, counted once per answer |

A name matches as a whole word, in any case. `Acme` does not match `Acmex`, and does match `Acme's`. The longest name is
matched first and its text is set aside, so a competitor called `Acme Pro` does not count as a mention of `Acme`, and
`Fathom` does not match inside `Fathom Analytics`. A name that is both a brand and a competitor counts as a brand. With no
brand names saved, the site's name is the brand.

Each brand and each competitor is one row with optional **aliases**: other spellings of the same name, such as the domain.
An answer that says "Acme (acme.example)" is one mention, one position and one share of voice for Acme. A row can also
have **exclusions**, phrases that cancel a match when they sit next to it. A competitor named `Linear` with the exclusion
`linear algebra` is not counted for "linear algebra". Up to 10 aliases and 10 exclusions a row.

Sentiment is scored after the answer is stored, never inside the check, so it cannot change the answer being measured.
See [Sentiment](#sentiment).

## Set it up

1. **Add prompts.** Open the AI visibility tab and add the questions a buyer would type, one per line: "best
   privacy-friendly analytics for indie hackers", "plausible alternative". A site keeps 100 prompts. Agents can add
   them too with the `add_ai_prompts` MCP tool or [`POST /api/v1/ai-prompts`](API.md#ai-visibility-pro).
2. **Add names.** Your brands and your competitors, up to 20 rows each, each with optional aliases and exclusions.
3. **Store a key per engine.** Each key is a Worker secret. It is never saved in the database and never sent to the
   dashboard.

   ```bash
   node scripts/wrangler.mjs secret put OPENAI_API_KEY
   node scripts/wrangler.mjs secret put ANTHROPIC_API_KEY
   node scripts/wrangler.mjs secret put GEMINI_API_KEY
   ```

   Perplexity on its own key (without DataForSEO) is `PERPLEXITY_API_KEY`. Google AI Overviews, and Perplexity through
   DataForSEO, use `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`.

   Set only the ones you want. Use a key with a spend limit set at the provider.
4. **Turn the engine on for the site** and, if you like, change its model. The model field takes any model id the engine
   accepts. The defaults are `gpt-6-luna` for OpenAI, `claude-haiku-5-5` for Anthropic and `gemini-3.8-flash` for Gemini.
5. **Set the monthly cap.** The default is 20 US dollars a site. 0 pauses the runs.
6. **Pick the schedule.** Smart (the default) asks each new prompt 3 times on its first day, then less often once its
   answers stop changing. Daily asks every prompt once a day. See [How checks are scheduled](#how-checks-are-scheduled).

The first check runs within the hour. The panel shows each engine's last error, such as a rejected key, until a later run
succeeds.

Two more engines are optional and each has its own section below: [Google AI Overviews](#google-ai-overviews) and
[Perplexity](#perplexity). Both can run through your DataForSEO login.

## How checks are scheduled

A single answer is a coin flip. The same prompt can name you on Monday and leave you out on Tuesday. So the smart
schedule (`schedule: "smart"`, the default) spends its checks where answers still move:

1. **Baseline.** A new prompt is asked 3 times on each engine on its first day. That gives a first mention rate on day
   one, instead of after 3 days.
2. **Settled.** When a prompt's last 4 answers on an engine agree (all name one of your brands, or none does), it is
   asked once a week on that engine.
3. **Open.** Any other prompt is asked every 2 days. One new answer that differs from the rest makes a settled prompt
   open again.
4. **Pacing.** The month's cap, minus what was spent before today, is split evenly over the days left in the month,
   today included. Once today's share is spent, the checks wait for tomorrow. Open prompts go first, then the ones that
   waited longest. Baseline answers are only held to the monthly cap, not to the day's share.

Only answers from the last 28 days count. A prompt that went unasked that long, for example because the cap paused it,
starts with a new baseline.

What this costs: 25 prompts on one engine at about $0.011 a check are 75 checks ($0.83) on the first day. After that a
settled prompt costs about 4 checks a month and an open one about 15, instead of 30 under the daily schedule.

`schedule: "daily"` asks every prompt once a day on every engine, as before. It suits a deployment that wants a fixed
row per prompt and day, or a cap large enough not to care.

The settings answer shows each prompt's state per engine (`baseline`, `open` or `settled`), its answers in the last 28
days and the day it is asked next (`prompts[].engines[]`).

## How a day runs

The cron (`*/5 * * * *`, which also runs the phone pushes and alert rules at minute 0, the X poll at minute 15, the Search Console sync at minute 30, the Meta ads import at minute 45 and the AI answer counts at minute 55) does this on every run for each site
that has an enabled engine with a key:

1. Lists the checks due today ([How checks are scheduled](#how-checks-are-scheduled)): under the daily schedule, each
   prompt on each enabled engine that has no answer today; under the smart schedule, missing baseline answers and the
   prompts whose interval has passed.
2. Takes all baseline answers the batch has room for, and a share of the rest: those checks divided by the runs left in
   the UTC day, rounded up. 150 checks at 00:00 UTC run as 1 a run. The next runs catch up a missed one.
3. Stops at 6 checks per run across all sites (`AI_CHECKS_PER_RUN`, 1 to 50), and starts at a different site each run so
   one site doesn't use the batch.
4. Asks each engine in turn, one check at a time. Different engines run side by side.
5. Before each check, compares the month's estimated spend with the cap. At the cap it skips the rest and the tab says
   "paused". Under the smart schedule a check after the baseline also waits for tomorrow once today's share is spent.
6. Stores one row per check in `ai_answers`: engine, model, cited URLs and domains, which names the answer contains with
   their order, an excerpt of 1,000 characters and the estimated cost. The answer and the month's spend are written in one
   batch, so a run that ends early never leaves a charge without an answer or an answer without its charge.

A bad key, a missing model, a rate limit, a server error or a timeout stops that engine until the next hour. Its message
shows in the settings. Any other failure, such as an answer with no text or a request the engine refuses, counts against
that prompt only: the run goes on with the next prompt, and a prompt that failed twice on an engine is skipped for the rest
of the UTC day. When a run finds nothing left for a site, it marks the site done for the day (`ai_settings.done_day`),
and later runs that day skip it without reading its answers. Saving the settings or adding a prompt clears the mark. A call the engine billed but that returned no text is added to the spend. A failed check stores no
answer. Each answer of a day has a sample number (0, 1, 2 for a baseline), and a second run for the same prompt, engine, day
and sample replaces the row. Before each engine call the run claims the check (`ai_claims`, 1 row), and a claim younger than 2 minutes stops an overlapping run from calling the engine again and being billed twice. The share of a run is taken per engine, so an engine that keeps failing and is backing off does not hold up the others.

Error messages are never stored as the engine sent them. A rejected key shows a fixed text, and any other message has key-like
strings removed first.

The surface of a runner row is the engine's label (`OpenAI API`, `Anthropic API`, `Gemini API`), so it never mixes with
a `ChatGPT` row an agent pushed from the web UI.

## Google AI Overviews

This engine asks Google, not a model with a search tool. It runs each tracked prompt as a Google query through DataForSEO
(SERP, `load_async_ai_overview` on) and stores what Google showed.

- **Turns on with** the `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` secrets (the same ones as [rank tracking](SEO.md)) and
  the engine switch for the site. Without the secrets the engine does nothing and the settings say which secrets to set.
- **Location and language** come from the site's rank tracking settings (United States and English until you change them).
- **How it runs.** It follows the rank tracking pattern. A tick claims up to 5 prompts in `ai_tasks` and posts them in one
  `task_post` call. Later ticks ask `tasks_ready` and collect up to 3 results with `task_get`. The claim stays until the
  answer is stored, so a lost answer costs one missed check and never a second payment.
- **What is stored.** `aio_present` (1 when Google showed an AI Overview), the overview text (the first 1,000 characters as the
  excerpt), whether a brand name is in it, and whether a reference on your domain is among its sources (counted as cited).
- **No overview.** Many queries get none. That row is stored as not measured, so it is not a miss. The tab and the reads
  leave it out of the mention and citation rates, and report `overview_checks`, `overviews_shown` and `overview_rate`, so
  you can see how many queries showed an overview at all. Rates for this engine are over the queries that did.
- **Cost.** About $0.0026 a check by our estimate: $0.0006 for the task and $0.002 for `load_async_ai_overview`. DataForSEO's
  own pages give two different prices for that add-on ($0.002 and $0.0006), and refund it when no overview is found. Read the
  real figure on your DataForSEO billing line.
- **Two caps, both checked.** The cost is added to the DataForSEO spend counter and to the AI spend of the month, so it
  counts toward both the AI cap above and the DataForSEO cap of rank tracking (SEO tab, Ranks). A check is posted only when
  both caps have room for it. A DataForSEO cap of $0 stops AI Overview and DataForSEO Perplexity checks as it stops rank
  checks. When that cap stops them, the engine shows "Paused: the DataForSEO cap ... is reached" in the AI tab until you
  raise the cap or the month turns. AI Overview spend does use room of the rank cap, and the rank tab says so when it
  reports its own cap as reached. To keep rank tracking safe, set the DataForSEO cap to what both need.
- **Rank estimate.** The overview cost stays out of the average that sizes rank batches, so AI Overview checks do not
  make rank tracking post fewer checks.

## Perplexity

- **Through DataForSEO.** When `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are set, a check calls AI Optimization, LLM
  Responses, Perplexity (Live) with model `sonar`. The model field in the settings does not apply. The answer, its
  annotations and its search results become the text and the citations. The call's own `cost` is stored and added to the
  DataForSEO counter and the AI spend, and the check needs room under both caps (see "Two caps" above). A sample call cost
  about $0.0067, which is the estimate shown.
- **On your own key.** Without DataForSEO, set `PERPLEXITY_API_KEY` (`wrangler secret put`). A check then calls the Perplexity
  Agent API, `POST https://api.perplexity.ai/v1/agent`, with the `web_search` tool. The default model is
  `openai/gpt-5.6-sol`, the model Perplexity's quickstart sends with `web_search`. Perplexity names no list of models that
  support web search, so if a model is refused, set another one (a `provider/model` name from Perplexity's model page) in the
  settings. Sources are read from the `search_results` items, not from markers in the text. The cost is
  `usage.cost.total_cost` when the response has it, else tokens plus $0.0025 a search.
- **Less tested.** The request body (`model`, `input`, `tools`, `max_output_tokens`) and the response fields above match
  Perplexity's API reference, but this path has run only against mocks, and the DataForSEO path has run against more samples.
  Parsing falls back to nothing on a missing field instead of failing.
- With both set, DataForSEO is used. Sonar Chat Completions is past its end date, so this engine does not call it.
- With neither set, the engine does nothing and the settings say which secrets to set.

## Sentiment

For each stored answer that names a brand, one short call labels it `positive`, `neutral` or `negative` and gives a
one-line reason. Per engine, the tab shows this week against last week as counts of each label.

- **Where it runs.** On the cron only, after the checks of a tick, at most 3 answers a tick and at most `sentiment_per_day`
  a site and UTC day. It is off by default (`sentiment_per_day` 0), because each rating is a paid call on your own engine key.
  The AI tab shows what one rating costs and a button that turns it on at 20 a day. The maximum is 500. A request never makes
  the call.
- **Which engine.** The cheapest of your enabled OpenAI, Anthropic and Gemini engines that has a key, by the list price of its
  model. It is a plain call with no web search and a 150 token answer. Its cost counts in the AI spend and under the
  monthly cap. Without such an engine the card says what to turn on. If a rating call fails, the engine shows a message
  ("Rating answers failed: ...") and no more ratings run that tick, but its paid checks are not paused.
- **Which answers.** Only answers of the last 14 days are rated. Older answers that were never rated count as `pending` in a
  longer window and stay that way.
- **The rubric.** Positive means the answer recommends or praises the brand. Negative means it warns against it, criticises
  it, or calls it worse or unreliable. Neutral means it names or lists the brand without a judgement. The reply must be
  JSON with a valid label. Anything else is stored as `unrated` and is not asked again.
- **Untrusted text.** The answer goes into the prompt between `<answer>` tags with any such tag in it broken, and the prompt
  says the text is web data and its instructions are to be ignored. Any spelling of the tag (spaces, case, attributes) is broken. Only the label (one of three words) and a reason of at most
  200 characters are stored. Treat the reason as untrusted text too.
- **Accuracy.** A label is one model's reading of one answer. We have not measured its accuracy against hand labels. Public
  accounts of LLM sentiment labelling say neutral is the hardest class. Use the counts, and read the answers behind a label
  you plan to act on.

## Cost

You pay each provider directly. FounderData estimates the cost of each check from what the engine reported: the search
calls at the provider's per-search price, and the input and output tokens at the model's list price. The estimate is
what the monthly cap compares against. Your provider's invoice is the truth.

The table below is the daily schedule. The smart schedule costs the same on a prompt's first day and less after it
([How checks are scheduled](#how-checks-are-scheduled)).

Per month at 50 prompts a day on one engine, which is 1,500 checks. Each check assumes one search call, 6,000 input
tokens and 900 output tokens, the size of the providers' own examples. Real answers vary, and the token part scales
linearly. Anthropic may search up to 3 times a check, and OpenAI and Gemini can search more than once, so the settings
show a range per engine: the typical check, and the most it costs with 3 searches at full price. The two extra searches add
$0.02 to a check.

| Engine and model | Per check | Per month, 50 prompts a day |
| --- | --- | --- |
| OpenAI `gpt-6-luna` | $0.0111 | $16.58 |
| OpenAI `gpt-5.6-luna` | $0.0123 | $18.42 |
| OpenAI `gpt-5.6-terra` | $0.0328 | $49.20 |
| Anthropic `claude-haiku-5-5` | $0.0111 | $16.58 |
| Anthropic `claude-sonnet-5-5` | $0.0310 | $46.50 |
| Gemini `gemini-3.8-flash` | $0.0079 in tokens, plus search | $11.81 in tokens |

Google AI Overviews and Perplexity through DataForSEO cost what DataForSEO bills, about $0.0026 and $0.007 a check by the
estimates above. Sentiment adds a fraction of a cent per rated answer.

Search fees are $10 per 1,000 calls for OpenAI and Anthropic, and $14 per 1,000 for Gemini after 5,000 free calls a
month, shared across Gemini 3 and newer models. At one search a check, Gemini's 1,500 searches stay inside the free
tier, so $11.81 is the bill. The runner subtracts the free tier from the cap estimate: it counts the Gemini searches of
every site on the deployment in the UTC month and charges the search fee only past 5,000, so the cap does not pause early.
The free tier belongs to your Google account, so queries made outside FounderData are not counted. Gemini 3.8 Flash doubles its token prices on 2027-01-01, which makes it $23.63 in tokens.

All three of the cheapest options together come to about $45 a month at 50 prompts a day, so raise the default 20 dollar
cap before you turn them all on. A model that is not in the price table is priced at a high default, so the cap stops
early rather than late. These prices come from the providers' pricing pages as of November 2026. Check them before you
rely on the numbers.

The cap is checked before each check. One check can end the month a little over it, and engines that run side by side can
add one more.

## Limits

| | |
| --- | --- |
| Prompts | 100 a site, 500 characters each |
| Names | 20 brands and 20 competitors a site, 100 characters each, with up to 10 aliases and 10 exclusions each |
| Checks | 6 a run across all sites by default. The cron runs 288 times a day, so up to 1,728 a day. 50 prompts on 3 engines are 150 checks, and the day's share spreads them over the day. A deployment that kept the hourly cron in `wrangler.local.jsonc` gets 144 a day until it adds `*/5 * * * *` |
| Answer | 3,000 output tokens asked for. Anthropic may search up to 3 times a check. 30,000 characters are read for names |
| History | A check is 1 row: a day holds up to 3 per prompt and engine on a baseline day, and 1 after that. Rows older than 200 days are deleted by the daily retention run. A report reads at most 90 days, and the 90 before them for the comparison |
| AI Overviews and sentiment | 5 prompts per `task_post`, 3 results collected a tick, 3 answers rated a tick. A post needs 4 subrequests, a collect 2 plus 2 per result, a rating 2. The AI Overview step and the check loop take turns going first, and every call checks the shared budget, so a busy tick stays under 50 which a test in the Pro repository checks |
| Free plan | The cron gets 10 ms of CPU, shared with the rank collection of the same invocation (and at minute 0 the phone pushes and alert rules), and the invocation's 50 subrequests, which every job of the run counts on one shared counter. An engine call mostly waits on the network, which is not CPU, but parsing an answer with its search results (tens of KB) and matching names is. A check is 2 subrequests (the call and the write), and each site adds about 3 more. So 6 checks a run is the default. Lower `AI_CHECKS_PER_RUN` if a run hits the CPU limit |
| Workers Paid | 30 s of CPU and 1,000 subrequests a run, so `AI_CHECKS_PER_RUN` can go to its limit of 50. An engine call times out after 90 seconds, so 50 checks on one engine can take over an hour of wall time: keep it near 10 per engine |

D1 rows written: a check writes 2 rows, the answer and the month's spend. A run of 6 checks on one engine writes 12 rows. A run with nothing pending writes 1 row the first time that day (the done mark), and none after it.
A check that failed for its own prompt writes 1 row for its failure count, and 1 more if the engine billed it. A Perplexity check through DataForSEO writes 3 rows (answer, AI spend, DataForSEO counter). An AI Overview prompt writes 4 rows to post (2N + 2 for N prompts in one post) and 2 to collect. A sentiment rating writes 2. Saving the
settings writes 1 row, each new prompt 1 row, plus 1 to clear the done mark when it is set. A cost test in the Pro
repository pins the numbers.

## Untrusted text

An answer is text from a model that read the open web, so it can contain instructions. FounderData matches it against
your names, keeps an excerpt and the URLs, and does nothing else with it. It never fetches a cited URL and never renders it as
HTML. The one exception is the sentiment label, which sends the answer to a model fenced as data (see [Sentiment](#sentiment)) and
keeps only a three-word label and a short reason. Agents that read it through MCP get the same warning in the tool
descriptions.

## Read it

| Where | What |
| --- | --- |
| Dashboard, AI visibility tab | Everything on this page, with the setup form |
| `GET /api/v1/ai-visibility` | The metrics as JSON ([API.md](API.md#ai-visibility-pro)) |
| `GET /api/v1/ai-answers?engine=openai` | The stored rows, with `engine`, `mentions` and `cost_usd` |
| `GET /api/v1/ai-sentiment` | Sentiment counts per engine ([API.md](API.md#ai-visibility-pro)) |
| MCP `get_ai_answers` (with `view: "visibility"` or `"sentiment"`), `add_ai_prompts` | The same, for agents ([MCP.md](MCP.md)) |
| Home's Growth row, `ai` on `GET /api/v1/portfolio` and MCP `get_portfolio` | Mention and citation rate per site against the window before. The Worker counts the checks per site and day once an hour, at minute 55, so today's checks can be up to an hour behind the tab |

## AI crawler hits

Crawlers fetch pages without running JavaScript, so the tracker never sees them. To count them, your server forwards each
request whose user agent names an AI crawler.

### The endpoint

`POST /api/sites/<site id>/crawler-hits` with the site's API key (`rt_...`, Settings, Payments) as the bearer token. Send up
to 500 hits:

```json
{ "hits": [ { "ua": "Mozilla/5.0 ... GPTBot/1.2 ...", "path": "/pricing", "status": 200 } ] }
```

| Field | |
| --- | --- |
| `ua` | Required. The request's user agent. Requests that match no AI crawler are counted in `ignored` and not stored |
| `path` | Required. A path or a full URL. The query and fragment are dropped |
| `status` | Optional. The HTTP status you answered, 100 to 599. Stored for 200, 204, 301, 302, 304, 400, 401, 403, 404, 410, 429, 500, 502 and 503, and as 0 for any other code. Without it the hit counts under status 0 and in neither the "ok" nor the "error" column |
| `verified` | Optional. `false` marks a hit whose IP your server checked and found wrong. It is counted in `unverified` and not stored |
| `ts` | Optional. ISO 8601 or Unix time within the last 7 days. Default: now |

```json
{ "ok": true, "accepted": 4, "ignored": 1, "unverified": 0, "rows": 3 }
```

The bearer is the site's API key, the same secret that signs payment webhooks, so keep it in the server's environment and rotate it for both at once. A wrong key and an unknown site both answer `401`. Read the result with `GET /api/v1/ai-crawlers`, or in the tab. The
read route takes `days` (1 to 90, default 30), `path` and `limit` (pages, 1 to 100, default 20).

### What gets classified

| Bot | Company | Purpose |
| --- | --- | --- |
| GPTBot | OpenAI | Training |
| OAI-SearchBot | OpenAI | Search |
| ChatGPT-User | OpenAI | A person asked |
| ClaudeBot, anthropic-ai | Anthropic | Training |
| Claude-SearchBot | Anthropic | Search |
| Claude-User | Anthropic | A person asked |
| PerplexityBot | Perplexity | Search |
| Perplexity-User | Perplexity | A person asked |
| Google-Extended, Google-CloudVertexBot | Google | Training, a person asked |
| Applebot-Extended, Bytespider, CCBot, Amazonbot, meta-externalagent, cohere-ai, Diffbot | various | Training |
| meta-externalfetcher, MistralAI-User, DuckAssistBot | Meta, Mistral, DuckDuckGo | A person asked |
| YouBot | You.com | Search |

Google-Extended and Applebot-Extended are robots.txt tokens. Google and Apple crawl under their normal user agents, so
these two rarely show up. The user agent must contain the bot name as a whole token: `MyGPTBotChecker` is not GPTBot.
A user agent is still only a claim, because anyone can send "GPTBot". FounderData never receives an IP address. To weed out
spoofs, check the client IP in your own server against the operator's published ranges and send `"verified": false` on
the hits that fail. Those are counted in `unverified` and not stored.

### Rows

A hit adds to a counter per UTC day, bot, path and status, not a row per hit. A request with N different combinations
writes N rows, however many hits it holds. 500 hits on one page are 1 row. The cap is 2,000 rows with a path for a site and day, read from one counter row. Past it, new combinations count under the path `(other)`, which holds at most one row per bot and status (22 bots, 16 statuses), so a site with a URL per search query can't write without limit. Two requests at the same moment may pass the cap by one request's rows. Rows are
deleted with the rest of the visit data after 24 months, or `RETENTION_MONTHS`.

Each forwarded request is also one Worker request. A site with thousands of crawler hits a day should buffer them in its
own code and send up to 500 at once.

### Next.js middleware

Put this in `middleware.ts`. It forwards only crawler requests, after the response is on its way. Middleware does not
see the status the page answers with, so these hits have no status.

```ts
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

const AI_BOTS =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|Applebot-Extended|Bytespider|CCBot|Amazonbot|meta-externalagent|meta-externalfetcher|MistralAI-User|DuckAssistBot|cohere-ai|YouBot|Diffbot/i;

export function middleware(req: NextRequest, event: NextFetchEvent) {
  const ua = req.headers.get('user-agent') ?? '';
  if (AI_BOTS.test(ua)) {
    event.waitUntil(
      fetch(`${process.env.FOUNDERDATA_URL}/api/sites/${process.env.FOUNDERDATA_SITE_ID}/crawler-hits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.FOUNDERDATA_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hits: [{ ua, path: req.nextUrl.pathname }] }),
      }).catch(() => {}),
    );
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

Set `FOUNDERDATA_URL` (such as `https://founderdata.example.com`), `FOUNDERDATA_SITE_ID` and `FOUNDERDATA_API_KEY` in the
site's environment. Keep the key on the server.

### Cloudflare Worker

For a site on Cloudflare, a Worker routed in front of the origin sees the status too. Add the three values as variables,
the key as a secret.

```js
const AI_BOTS =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|Applebot-Extended|Bytespider|CCBot|Amazonbot|meta-externalagent|meta-externalfetcher|MistralAI-User|DuckAssistBot|cohere-ai|YouBot|Diffbot/i;

export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const ua = request.headers.get('user-agent') || '';
    if (AI_BOTS.test(ua)) {
      ctx.waitUntil(
        fetch(`${env.FOUNDERDATA_URL}/api/sites/${env.FOUNDERDATA_SITE_ID}/crawler-hits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.FOUNDERDATA_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ hits: [{ ua, path: new URL(request.url).pathname, status: response.status }] }),
        }).catch(() => {}),
      );
    }
    return response;
  },
};
```

## Privacy

The runner sends your prompts, and only your prompts, to the engines you turned on. No visitor data leaves FounderData.
Crawler hits hold a user agent's bot name, a path and a status. The user agent string and the IP address are not stored.
