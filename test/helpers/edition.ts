// Tests that need FounderData Pro (docs/PRO.md) run in a Pro checkout and are skipped in core, where Pro's routes,
// tools and cron jobs do not exist. A core-only expectation uses `itCore`.
import { describe, it } from 'vitest';
import { pro } from '../../src/worker/edition';

export const isPro = pro !== null;
export const itPro = isPro ? it : it.skip;
export const itCore = isPro ? it.skip : it;
export const describePro = isPro ? describe : describe.skip;

/** A Pro module, for a core test file whose Pro cases run only in a Pro checkout. Load it inside an `itPro` case. */
export const proModule = (p: string): Promise<any> => import(/* @vite-ignore */ `../../pro/${p}`);
