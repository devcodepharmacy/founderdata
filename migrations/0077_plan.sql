-- The plan: the growth project an owner's AI agent runs for one site (FounderData Pro, pro/worker/plan.ts, docs/API.md
-- "Plan (Pro)"). The agent writes it through the MCP tools; the dashboard's Plan tab reads it, and the owner may tick
-- a task that is theirs. A task's result is its note's verdict (notes, src/worker/notes.ts): nothing here stores one.
-- No table holds personal data, so erasing a person needs nothing. Deleting a site deletes its rows in all five per-site
-- tables; plan_portfolio holds one row for the whole deployment.
--
-- Rows written per write path (pinned in pro/test/cost.test.ts, listed in the README cost table):
--   create the plan                       1
--   change the document                   2 (the plan row, and the previous document in plan_versions);
--                                         3 once the site has 30 older versions (the oldest is deleted)
--   change only cadence_hours or share   1
--   change the portfolio rules            1 (plan_portfolio); plus the plan's own rows when the same call changes it
--   a task, new or changed                1 each
--   the owner ticks a task, or undoes it  1
--   a session                             2 (the session, and plans.last_session_at, or plans.last_failure for a failed
--                                         run); 3 with an idempotency key; plus 1 per verdict it keeps (8 at most a
--                                         call, each task once)
--   a review                              1; 2 with an idempotency key; plus 1 per verdict it keeps (every closed
--                                         window of its period without one)
--   reading the plan                      0: reads judge at most 2 uncached closed windows live and store nothing
--   the away alert                        2 per plan (the alert inbox row, and plans.away_alerted_at)
--   delete the plan                       1 per row deleted

-- plans: one row per site.
--   version          counts saved versions of the document (title, summary, body, rules, reach, goals)
--   version_at       ms, when the current version was saved
--   reason           300 characters: why the current version was saved, shown in the history
--   title            120 characters, such as "Grow Acme to 5,000 USD MRR"
--   summary          400 characters: what we are doing, in two sentences a person reads first
--   body             Markdown, 20,000 characters: the strategy
--   rules            JSON { alone, ask, never }: what the agent does alone, asks the owner first and never does. Each a
--                    list of 0 to 12 items of 1 to 200 characters
--   reach            JSON { can, cannot }: what the agent can reach (code, App Store Connect) and cannot. Same limits
--   share            JSON { hours_per_week (half hours), money_per_month }, each nullable: this plan's slice of the portfolio's hours
--                    and money (plan_portfolio). Not versioned, like cadence_hours
--   goals            JSON array, 5 at most: { id, text, metric, target, baseline, start, due, status }
--   cadence_hours    how often the agent is expected to work, 1 to 720; NULL: no schedule
--   last_session_at  ms, the start of the newest session
--   away_alerted_at  ms, when the "agent is away" alert went out for the current gap; a session clears it
--   last_failure     JSON { at, cause, link }: the newest failed run (a session with status failed). A failed run does
--                    not move last_session_at, so the away alert still counts the gap
CREATE TABLE plans (
  site_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  version_at INTEGER NOT NULL,
  reason TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '{"alone":[],"ask":[],"never":[]}',
  reach TEXT NOT NULL DEFAULT '{"can":[],"cannot":[]}',
  share TEXT,
  goals TEXT NOT NULL DEFAULT '[]',
  cadence_hours INTEGER,
  last_session_at INTEGER,
  away_alerted_at INTEGER,
  last_failure TEXT,
  actor TEXT
) WITHOUT ROWID;

-- plan_versions: the older versions of the document, written when title, summary, body, rules, reach or goals change. Each
-- row is a version as it was saved, with its own reason, actor and time. The newest 30 are kept per site.
CREATE TABLE plan_versions (
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  rules TEXT NOT NULL,
  reach TEXT NOT NULL,
  goals TEXT NOT NULL,
  reason TEXT,
  actor TEXT,
  PRIMARY KEY (site_id, version)
) WITHOUT ROWID;

-- plan_tasks: the plan's to do list. 60 open tasks (todo or doing) per site at most.
--   title     200 characters, starts with a verb
--   detail    Markdown, 4,000 characters
--   why       500 characters: what this should move, and by how much
--   owner     agent or human
--   status    todo, doing, done or dropped
--   goal_id   a goal id of the plan, or NULL
--   note_id   the note that logged the change this task shipped, or NULL; its verdict is the task's result
--   outcome   1,000 characters: what happened, set when done or dropped (the owner's comment when they tick it)
--   due       YYYY-MM-DD or NULL
--   position  order inside a status, lowest first
--   done_at   ms; done_by: agent or human, who closed it
--   kind      task, or approval: a yes or no the owner gives (owner human only). Yes closes it done, no dropped
--   expect    JSON { text, metric, change_pct }: what the agent expects the task to move. Required on a new agent task
--   allowed_by  JSON: why the agent could ship a change the rules say to ask about. { kind: approval, task_id, at,
--               title } (an approval task the owner said yes to) or { kind: rule, rule } (an item of a rules' alone)
--   claimed_by  64 characters: the run_id that moved the task to doing; claimed_at ms. Another run_id gets 409 for
--               6 hours. Done or dropped clears both
--   action    JSON { label, url }: the button on an owner task, url a dashboard path or an https URL. An agent never
--             closes an owner task as done: only the owner's tick route does
--   result_cache  JSON: a cache of the verdict of the note's closed window ({ note_id, full, public }: with and without
--                 revenue). The note stays the source; a write path (a session or a review) fills it once per task
--                 and note, and a new note_id on the task leaves it unused until it is filled again
--   tick_undo     JSON: the status and outcome before the owner ticked the task, so undo puts them back
CREATE TABLE plan_tasks (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  why TEXT,
  owner TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'todo',
  goal_id TEXT,
  note_id TEXT,
  outcome TEXT,
  due TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  done_by TEXT,
  actor TEXT,
  result_cache TEXT,
  tick_undo TEXT,
  kind TEXT NOT NULL DEFAULT 'task',
  expect TEXT,
  allowed_by TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  action TEXT,
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;

-- plan_sessions: one row per time the agent worked on the plan. The key starts with the time, so the timeline is a
-- range of the primary key.
--   summary          300 characters: one line a person reads in the timeline
--   body             Markdown, 6,000 characters: what it checked, did and learned
--   next             1,000 characters: what it will do next time
--   trigger          manual (the owner asked), schedule or alert
--   idempotency_key  one per site: a second POST with the same key stores nothing and answers the first session
--   status           ok, or failed: the run broke (the workflow's failure step logs it), with cause (300 characters)
--                    and link (an https URL, such as the GitHub Actions run)
CREATE TABLE plan_sessions (
  site_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  id TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  next TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  actor TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  cause TEXT,
  link TEXT,
  PRIMARY KEY (site_id, started_at, id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX plan_sessions_idem ON plan_sessions (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- plan_reviews: the agent's check-ins, every 2 to 4 weeks.
--   from_day, to_day  the period the review covers, YYYY-MM-DD in the site's timezone
--   title             200 characters
--   body              Markdown, 8,000 characters: the agent's story
--   numbers           JSON FounderData computed when the review was stored: goals with progress, tasks done,
--                     dropped, open, measured and measuring (pro/worker/plan-numbers.ts), verdicts of the tasks with a
--                     note, sessions
CREATE TABLE plan_reviews (
  site_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  id TEXT NOT NULL,
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  numbers TEXT NOT NULL DEFAULT '{}',
  actor TEXT,
  idempotency_key TEXT,
  PRIMARY KEY (site_id, created_at, id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX plan_reviews_idem ON plan_reviews (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- plan_portfolio: the owner's rules over every plan, one row (id 'all'). Only a key for every site, or the owner's
-- login, writes it. The agent obeys these and the plan's own rules together; never in either wins.
--   rules            JSON { alone, ask, never }, as plans.rules
--   hours_per_week   the owner's hours for all plans together, in half hours (2.5); NULL: not set
--   money_per_month  minor units of currency, for all plans together; NULL: not set
--   currency         ISO 4217
CREATE TABLE plan_portfolio (
  id TEXT PRIMARY KEY,
  rules TEXT NOT NULL DEFAULT '{"alone":[],"ask":[],"never":[]}',
  hours_per_week REAL,
  money_per_month INTEGER,
  currency TEXT,
  updated_at INTEGER NOT NULL,
  actor TEXT
) WITHOUT ROWID;
