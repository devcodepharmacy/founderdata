# FounderData Pro

FounderData comes in two editions built from one code base.

**Core** is this repository. It's free and MIT licensed. It tracks your websites, takes in payments from Stripe, Dodo,
Polar, Lemon Squeezy, Paddle, Gumroad, the App Store and RevenueCat, and ties each payment to the visit that brought the
buyer. It also has goals, funnels, page speed, alerts, the weekly report, CSV export, GDPR erasure, share links, the
read API and an MCP server with 9 tools.

**Pro** is core plus a `pro/` folder from a private repository. You pay €19.99 or $19.99 once and get every future
update. Pro adds:

- MRR and its movement, trials, churn, LTV and a retention grid per source, plan and provider, with history imports
  from ChartMogul and RevenueCat
- iOS app analytics (onboarding funnel, paywall, retention), App Store sales, Apple Search Ads, ASO, and the iPhone
  app with widgets and a push for every payment
- Meta ads with the Conversions API, spend from every other channel, MER, CAC and payback
- Search Console, Google rank tracking, the Content view and a page audit
- AI visibility in ChatGPT, Claude, Gemini and Perplexity
- Home across all your sites with the Growth row, next actions, and a verdict on every change you log
- All 30 MCP tools, the `query` tool, alert rules, the alert inbox, the research log and agent skills
- Teammates with their own login

Both editions run on your own Cloudflare account, and your data stays in your own D1 database.

Core stores everything that arrives from outside in both editions: page views, app events and every payment and
subscription your providers send. When you switch to Pro, the Pro reports cover your history from the first day.

## Buy

The **Get the lifetime license** button in a core dashboard opens the checkout. Polar handles the payment and the tax,
then invites your GitHub account to the private Pro repository. That access is your license.

## Install Pro

Pro installs with git, so the changes you made to your own copy stay. In the dashboard, open a Pro section or
Settings, click **Already bought? Install Pro** and paste the prompt into the AI agent that manages your deployment
(Claude Code, Cursor, Codex). The prompt tells it to:

1. Commit your uncommitted changes.
2. Add the Pro repository as the `pro` remote, fetch it and run `git merge pro/main`.
3. Resolve conflicts so your changes and Pro's both survive.
4. Run `npm install`, `npm run typecheck && npm test`, then `npm run setup` to migrate and deploy.

By hand:

```bash
git remote add pro https://github.com/founderdata/founderdata-pro.git
git fetch pro
git merge pro/main
npm install && npm run typecheck && npm test
npm run setup
```

Pro differs from core in the `pro/` folder and in two one-line files, `src/worker/edition.ts` and
`src/dashboard/edition.ts`. A merge conflict means you changed a file that the release changed too.

## Updates

Settings has an **Updates** card. **Check for updates** reads `release.json` from this repository's `main` branch in
your browser and compares it with the version you deployed. The card gives you the prompt for your agent either way.

- Core: `git fetch upstream && git merge upstream/main`, with `upstream` pointing at this repository.
- Pro: `git fetch pro && git merge pro/main`. Every Pro release contains the core release of the same version, so one
  merge brings both.

Then run `npm run setup` as for the first deploy. It applies new migrations and keeps your password and data.

## How the editions fit together

This is for contributors.

- `src/worker/edition.ts` exports `pro`. It's `null` in core. Pro changes the file to export the object from
  `pro/worker/index.ts`. `src/dashboard/edition.ts` does the same for the dashboard (`proUi`).
- `src/worker/pro-hooks.ts` lists every place Pro plugs in: routes, cron jobs, MCP tools, digest sections and more.
  Each hook is optional. Core calls it only when Pro is there and works without it.
- In the dashboard, a Pro section resolves to Pro's component or to the Pro card (`src/dashboard/lib/pages.ts`). Pro
  panels inside core pages render through `ProSlot` by name.
- Core never imports from `pro/`. `test/edition.test.ts` fails if a core file does.
- `npm run check:core` copies the tree without `pro/`, switches the edition files to core, and runs the typecheck, the
  dashboard build and the tests there. In a Pro checkout, run it before every commit.
- Migrations live in core for both editions, so a database moves between editions without a migration of its own.
