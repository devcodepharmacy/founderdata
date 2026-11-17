// Which jobs a scheduled invocation runs (docs/ASO.md "What fits the free plan", README "What it costs").
//
// A Workers Free invocation may make 50 subrequests, D1 queries included, so the hourly jobs do not share a tick. On the
// five-minute cron (TICK_CRON) every tick collects and posts rank checks and runs AI checks, and one tick an hour in each
// slot runs one hourly job:
//
//   minute 0   phone pushes, alert rules, and at 07:00 UTC the daily alerts (that tick makes no rank or AI work)
//   minute 5   on Mondays at 07:05 UTC the weekly report (that tick makes no rank or AI work); later Monday hours try
//              again for a channel that refused it or that the 07:05 run never reached
//   minute 15  the X poll
//   minute 30  the Search Console sync
//   minute 45  the Meta ads import (pro/worker/meta.ts)
//   minute 50  next actions, a few sites a run until each site has today's (pro/worker/actions.ts)
//   minute 55  the AI answer counts Home's Growth row and get_portfolio read (pro/worker/growth.ts refreshAiDaily)
//
// Every tick also sends what the Meta Conversions API has pending (pro/worker/meta-capi.ts), before the rank and AI work.
//
// A slot is the first tick in its five minutes, so a tick that Cloudflare delivers a little late still lands in it. The
// jobs of one invocation run one after the other and draw on one SubrequestBudget (subrequests.ts).
// A deployment that kept the old hourly cron ('0 * * * *') runs every job once an hour in one invocation, with the same budget.
import { ALERTS_CRON } from './digest';

/** Minutes between the short cron ticks (the TICK_CRON in wrangler.jsonc). A deployment that still has the hourly cron runs every 60. */
export const TICK_MINUTES = 5;
/** The cron expression of those ticks. wrangler.jsonc lists it; the Worker tells it from the hourly '0 * * * *' that older deployments keep. */
export const TICK_CRON = '*/5 * * * *';
/** The hourly cron in wrangler.jsonc. At 07:00 UTC it also runs the daily alerts (index.ts). */
export const HOURLY_CRON = '0 * * * *';

/** The App Store sales import (FounderData Pro): the last three days again at 10:30 UTC. */
export const ASC_CRON = '30 10 * * *';
/** Retention, conversion and the other nightly work. Any cron that is not the tick, the hourly or the App Store one runs it. */
export const NIGHTLY_CRON = '17 3 * * *';

export const HOUR_MINUTE = 0;
export const X_MINUTE = 15;
export const GSC_MINUTE = 30;
export const META_MINUTE = 45;
export const WEEKLY_MINUTE = 5;
export const ACTIONS_MINUTE = 50;
/** The UTC hour of the daily alerts and, on Mondays, of the weekly report's tick. */
export const REPORT_HOUR = 7;
export const AI_DAILY_MINUTE = 55;

export interface Plan {
  /** Minutes between rank and AI runs: 5 on the tick cron, 60 on the hourly one. */
  tickMinutes: number;
  /** Phone pushes, alert rules, the idle import sweep and the tick length record. */
  hour: boolean;
  /** The 07:00 UTC alerts and the weekly Apple Ads popularity run. */
  daily: boolean;
  x: boolean;
  gsc: boolean;
  /** The Meta ads import. */
  meta: boolean;
  /** Monday's weekly report (digest.ts runWeeklyReport). */
  weekly: boolean;
  /** Monday after the report: send it to a channel that refused it or that no run reached (one read when none). */
  weeklyRetry: boolean;
  /** Next actions for the sites that have none for today (actions.ts). */
  actions: boolean;
  /** The hourly AI answer counts per site and day. */
  aiDaily: boolean;
  /** Rank collection and posting, and AI checks. */
  work: boolean;
  /** The hourly jobs come before the rank and AI work (a tick slot) or after it (the old hourly cron, one run an hour). */
  slotFirst: boolean;
}

const inSlot = (minute: number, at: number) => minute >= at && minute < at + TICK_MINUTES;

/** What an invocation of `cron` at `scheduledTime` runs. Null for the crons that are not the tick or the hourly cron. */
export function planFor(cron: string, scheduledTime: number): Plan | null {
  const d = new Date(scheduledTime);
  const minute = d.getUTCMinutes();
  const at7 = d.getUTCHours() === REPORT_HOUR;
  const monday = d.getUTCDay() === 1;
  if (cron === TICK_CRON) {
    const hour = inSlot(minute, HOUR_MINUTE);
    const daily = hour && at7;
    const five = inSlot(minute, WEEKLY_MINUTE) && monday;
    const weekly = five && at7;
    return {
      tickMinutes: TICK_MINUTES,
      hour,
      daily,
      x: inSlot(minute, X_MINUTE),
      gsc: inSlot(minute, GSC_MINUTE),
      meta: inSlot(minute, META_MINUTE),
      weekly,
      weeklyRetry: five && d.getUTCHours() > REPORT_HOUR,
      actions: inSlot(minute, ACTIONS_MINUTE),
      aiDaily: inSlot(minute, AI_DAILY_MINUTE),
      work: !daily && !weekly,
      slotFirst: true,
    };
  }
  if (cron === HOURLY_CRON) {
    return { tickMinutes: 60, hour: true, daily: at7, x: true, gsc: true, meta: true, weekly: monday && at7, weeklyRetry: monday && d.getUTCHours() > REPORT_HOUR, actions: true, aiDaily: true, work: true, slotFirst: false };
  }
  return null;
}

/** The old '0 7 * * *' cron that a deployment may still list. It sends the daily alerts and runs the alert rules. */
export const isDailyOnlyCron = (cron: string) => cron === ALERTS_CRON;
