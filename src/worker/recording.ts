// The site settings of Record visits and Remember visitors (migration 0071, docs/GUIDE.md "People and recordings (Pro)").
// Core stores them and the tracker reads them from the pageview answer (collect.ts trackerConfig). FounderData Pro
// draws the card that changes them and decides which visits to record.
import type { Site } from './env';

/** The columns PATCH /api/sites/:id takes for this feature. */
export const RECORDING_FIELDS = ['record_visits', 'record_sample', 'record_keep_days', 'record_daily_max', 'record_only_active', 'remember_visitors'] as const;
export type RecordingField = (typeof RECORDING_FIELDS)[number];

/** Days a recording can be kept. */
export const KEEP_DAYS = [7, 30, 90];
/** The highest "most visits a day" a site can set. */
export const MAX_DAILY = 100_000;

/**
 * Copies the recording settings in a PATCH body onto `next`, or returns the error to answer. Switches take 0, 1, true or
 * false; the numbers must be whole and in range.
 */
export function patchRecording(b: Record<string, unknown>, next: Site): string | null {
  for (const k of ['record_visits', 'record_only_active', 'remember_visitors'] as const) {
    if (b[k] !== undefined) next[k] = b[k] ? 1 : 0;
  }
  if (b.record_sample !== undefined) {
    const n = Number(b.record_sample);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'Enter the share of visits as a whole percent from 1 to 100';
    next.record_sample = n;
  }
  if (b.record_keep_days !== undefined) {
    const n = Number(b.record_keep_days);
    if (!KEEP_DAYS.includes(n)) return 'Keep recordings for 7, 30 or 90 days';
    next.record_keep_days = n;
  }
  if (b.record_daily_max !== undefined) {
    const n = Number(b.record_daily_max);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY) return `Enter the most visits a day as a whole number from 1 to ${MAX_DAILY.toLocaleString('en-US')}`;
    next.record_daily_max = n;
  }
  return null;
}
