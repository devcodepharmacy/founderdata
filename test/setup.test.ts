import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataLocation } from '../src/worker/location';

// Plain .mjs script; a non-literal path keeps TypeScript from looking for its types.
const SCRIPT = '../scripts/setup.mjs';
const ID = '3f2b9c1e-8d4a-4f6b-9e2d-1a7c5b8e0f42';

describe('scripts/setup.mjs', () => {
  it('finds a database by name in `wrangler d1 list --json` output', async () => {
    const { findDatabase } = await import(/* @vite-ignore */ SCRIPT);
    const list = `\n ⛅️ wrangler 4\n[{ "uuid": "${ID}", "name": "founderdata" }, { "uuid": "other", "name": "blog" }]`;
    expect(findDatabase(list, 'founderdata')).toBe(ID);
    expect(findDatabase(list, 'missing')).toBeNull();
    expect(findDatabase('Not logged in', 'founderdata')).toBeNull();
  });

  it('tells a deployment on the hourly cron about the 5-minute one, and says nothing to the shipped config', async () => {
    const { staleCronNotice } = await import(/* @vite-ignore */ SCRIPT);
    const shipped = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(shipped).toContain('"*/5 * * * *"');
    expect(staleCronNotice(shipped)).toBeNull();
    const old = shipped.replace('"*/5 * * * *"', '"0 * * * *"');
    expect(staleCronNotice(old)).toMatch(/\*\/5 \* \* \* \*/);
    expect(staleCronNotice('{ "triggers": { "crons": ["0 7 * * *"] } }')).toBeNull();
  });

  it('warns about a config that lists both the hourly cron and the 5-minute one', async () => {
    const { staleCronNotice } = await import(/* @vite-ignore */ SCRIPT);
    const shipped = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const both = shipped.replace('"*/5 * * * *"', '"0 * * * *", "*/5 * * * *"');
    const note = staleCronNotice(both);
    expect(note).toMatch(/both the hourly cron/);
    expect(note).toMatch(/run twice/);
  });

  it('renames the database in a config and keeps the comments', async () => {
    const { readDatabaseName, writeDatabaseName } = await import(/* @vite-ignore */ SCRIPT);
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(readDatabaseName(config)).toBe('founderdata');
    const updated = writeDatabaseName(config, 'my-analytics');
    expect(readDatabaseName(updated)).toBe('my-analytics');
    const comments = (text: string) => text.split('\n').filter((l) => l.trim().startsWith('//'));
    expect(comments(updated)).toEqual(comments(config));
  });

  it('writes the jurisdiction as a var the Worker reads', async () => {
    const { writeVar, databaseJurisdiction } = await import(/* @vite-ignore */ SCRIPT);
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const strip = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const once = writeVar(config, 'DATA_JURISDICTION', 'eu');
    expect(strip(once).vars).toEqual({ DATA_JURISDICTION: 'eu' });
    expect(strip(once).d1_databases).toEqual(strip(config).d1_databases);
    expect(writeVar(once, 'DATA_JURISDICTION', 'eu')).toBe(once);
    expect(strip(writeVar(once, 'DATA_JURISDICTION', 'fedramp')).vars).toEqual({ DATA_JURISDICTION: 'fedramp' });
    expect(strip(writeVar('{ "name": "x", "vars": { "A": "1" } }', 'DATA_JURISDICTION', 'eu')).vars).toEqual({ DATA_JURISDICTION: 'eu', A: '1' });
    expect(strip(writeVar('{ "name": "x", "vars": {} }', 'DATA_JURISDICTION', 'eu')).vars).toEqual({ DATA_JURISDICTION: 'eu' });
    const list = `[{ "uuid": "${ID}", "name": "founderdata", "jurisdiction": "EU" }, { "uuid": "other", "name": "blog" }]`;
    expect(databaseJurisdiction(list, 'founderdata')).toBe('eu');
    expect(databaseJurisdiction(list, 'blog')).toBeNull();
  });
});

describe('data location', () => {
  it('says EU only when the var says so', () => {
    expect(dataLocation({ DATA_JURISDICTION: 'eu' })).toMatchObject({ jurisdiction: 'eu', stored: 'EU (D1 jurisdiction eu)' });
    expect(dataLocation({ DATA_JURISDICTION: ' EU ' }).jurisdiction).toBe('eu');
    expect(dataLocation({})).toMatchObject({ jurisdiction: null, stored: 'Not pinned to a region' });
    expect(dataLocation({ DATA_JURISDICTION: 'mars' }).jurisdiction).toBeNull();
    expect(dataLocation({}).processed).toMatch(/hashes the IP address and user agent in memory/);
    // The retention the DPA paragraph quotes, in the days pruneOldData cuts at.
    expect(dataLocation({})).toMatchObject({ retention_days: 730, pii_retention_days: null });
    expect(dataLocation({ RETENTION_MONTHS: '12', PII_RETENTION_MONTHS: '6' })).toMatchObject({ retention_days: 365, pii_retention_days: 183 });
  });
});
