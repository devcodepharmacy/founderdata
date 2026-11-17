#!/usr/bin/env node
// One-command install on your Cloudflare account:
//
//   npm install
//   npm run setup                 # or: node scripts/setup.mjs --name my-analytics
//   npm run setup -- --jurisdiction eu    # a new database that stays in the EU (docs/PRIVACY.md)
//
// 1. Signs in to Cloudflare with Wrangler if needed.
// 2. Creates the D1 database, or finds it when it already exists. wrangler.jsonc names it and holds no id: Wrangler
//    finds the database by name. With --name, the name goes into wrangler.local.jsonc (gitignored). With
//    --jurisdiction eu (or fedramp) a new database is created in that jurisdiction. Cloudflare can't move an existing
//    database, so for one that exists the flag only prints a warning. The jurisdiction of a new database (or of an
//    existing one, when `wrangler d1 list` names it) goes into wrangler.local.jsonc as the DATA_JURISDICTION var, so
//    Settings and /api/v1/definitions can say where the data is stored.
// 3. Creates the admin password and session secret, saved in ~/.config/founderdata/ (mode 600). An existing file is
//    reused, and ADMIN_PASSWORD in the environment wins over both.
// 4. Builds the dashboard, applies the database migrations and deploys the Worker with both secrets.
//
// Running it again is safe: it reuses the database and the secrets and deploys the current code.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reads `database_name` of the DB binding from wrangler config text. */
export function readDatabaseName(config) {
  return config.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

/** Wrangler config text with the database name replaced, comments and layout kept. */
export function writeDatabaseName(config, name) {
  return config.replace(/("database_name"\s*:\s*)"[^"]*"/, `$1"${name}"`);
}

/** The uuid of the database called `name` in `wrangler d1 list --json` output, or null. */
export function findDatabase(listOutput, name) {
  try {
    return JSON.parse(listOutput.slice(listOutput.indexOf('['))).find((d) => d.name === name)?.uuid ?? null;
  } catch {
    return null;
  }
}

/** The jurisdiction of the database called `name` in `wrangler d1 list --json` output, when Wrangler reports one. */
export function databaseJurisdiction(listOutput, name) {
  try {
    const j = JSON.parse(listOutput.slice(listOutput.indexOf('['))).find((d) => d.name === name)?.jurisdiction;
    return typeof j === 'string' && JURISDICTIONS.includes(j.toLowerCase()) ? j.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Wrangler config text with `"vars": { key: value }` set, comments and layout kept. Replaces the key when it is there,
 * adds it to an existing `vars` object, or adds a `vars` object at the end of the config.
 */
export function writeVar(config, key, value) {
  const quoted = JSON.stringify(value);
  const existing = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (existing.test(config)) return config.replace(existing, `$1${quoted}`);
  const vars = /"vars"\s*:\s*\{(\s*\})?/;
  const found = config.match(vars);
  if (found) return config.replace(vars, found[1] ? `"vars": { "${key}": ${quoted} }` : `${found[0]} "${key}": ${quoted},`);
  const end = config.lastIndexOf('}');
  const before = config.slice(0, end).replace(/\s*$/, '');
  const comma = before.endsWith(',') || before.endsWith('{') ? '' : ',';
  return `${before}${comma}\n  // Where the D1 database stores its data (src/worker/location.ts). Written by npm run setup.\n  "vars": { "${key}": ${quoted} }\n${config.slice(end)}`;
}

/**
 * A note for a config whose crons would misbehave. Two cases, both read-only (the file is never rewritten: a deployment's
 * own config is its owner's), null when there is nothing to say:
 * - the hourly cron "0 * * * *" without "*" every 5 minutes: it keeps working and runs the rank and AI checks once an hour
 *   (144 results and 144 AI checks a day on Free, not 1,728 each);
 * - both of them: at minute 0 the hourly jobs (phone pushes, alert rules, the X poll, the Search Console sync and the 07:00
 *   alerts) run in two invocations at once, and the rank and AI work runs twice. Keep only the five-minute cron.
 */
export function staleCronNotice(config) {
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
  const hourly = crons.includes('"0 * * * *"');
  const tick = crons.includes('"*/5 * * * *"');
  if (hourly && tick) {
    return 'your config lists both the hourly cron "0 * * * *" and "*/5 * * * *". At minute 0 the hourly jobs (pushes, alert rules, X poll, Search Console sync, 07:00 alerts) would run twice. Remove "0 * * * *" from wrangler.local.jsonc and keep "*/5 * * * *".';
  }
  if (!hourly || tick) return null;
  return 'your config runs the hourly cron "0 * * * *", so DataForSEO and AI checks run 24 times a day. Replace it with "*/5 * * * *" in wrangler.local.jsonc to get 288 runs a day (README, "Rank checks and AI checks, by plan").';
}

/** D1 jurisdictions `wrangler d1 create --jurisdiction` accepts. */
export const JURISDICTIONS = ['eu', 'fedramp'];

/** The value of --jurisdiction in `args` (also --jurisdiction=eu), lowercased; null when absent. Throws on an unknown one. */
export function readJurisdiction(args) {
  const at = args.findIndex((a) => a === '--jurisdiction' || a.startsWith('--jurisdiction='));
  if (at < 0) return null;
  const value = (args[at].includes('=') ? args[at].split('=')[1] : args[at + 1] ?? '').toLowerCase();
  if (!JURISDICTIONS.includes(value)) throw new Error(`--jurisdiction must be one of: ${JURISDICTIONS.join(', ')}`);
  return value;
}

const CONFIG = 'wrangler.jsonc';
const LOCAL_CONFIG = 'wrangler.local.jsonc';
const SECRETS_DIR = join(homedir(), '.config', 'founderdata');

/** Runs Wrangler through scripts/wrangler.mjs, so wrangler.local.jsonc wins when it exists. */
function wrangler(args, { capture = false, stdin = 'inherit' } = {}) {
  const res = spawnSync(process.execPath, ['scripts/wrangler.mjs', ...args], {
    encoding: 'utf8',
    stdio: capture ? [stdin, 'pipe', 'pipe'] : 'inherit',
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function step(text) {
  console.log(`\n▸ ${text}`);
}

function fail(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}

/** Reads a secret from ~/.config/founderdata/<file>, or creates and saves it. */
function secret(file, make) {
  const path = join(SECRETS_DIR, file);
  if (existsSync(path)) return { value: readFileSync(path, 'utf8').trim(), path, created: false };
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const value = make();
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { value, path, created: true };
}

/** Runs `wrangler deploy`, showing its output and returning it. stdin stays attached so its prompts still work. */
function deploy(secretsFile) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, ['scripts/wrangler.mjs', 'deploy', '--secrets-file', secretsFile], { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const nameAt = args.indexOf('--name');
  let jurisdiction;
  try {
    jurisdiction = readJurisdiction(args);
  } catch (e) {
    fail(e.message);
  }
  if (!existsSync(CONFIG)) fail(`Run this from the repository root (no ${CONFIG} here).`);
  if (!existsSync('node_modules')) fail('Run `npm install` first.');

  step('Checking the Cloudflare login');
  const who = wrangler(['whoami'], { capture: true });
  if (!who.ok || /not authenticated/i.test(who.out)) {
    if (!wrangler(['login']).ok) fail('Wrangler login failed. Run `npx wrangler login` and try again.');
  }

  const configFile = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
  const configured = readDatabaseName(readFileSync(configFile, 'utf8'));
  const cronNote = staleCronNotice(readFileSync(configFile, 'utf8'));
  if (cronNote) console.log(`  note: ${cronNote}`);
  const name = nameAt >= 0 ? args[nameAt + 1] : configured ?? 'founderdata';
  if (!name) fail('--name needs a database name.');
  if (name !== configured) {
    writeFileSync(LOCAL_CONFIG, writeDatabaseName(readFileSync(configFile, 'utf8'), name));
    console.log(`  database name ${name} written to ${LOCAL_CONFIG} (gitignored)`);
  }

  step(`Finding or creating the D1 database "${name}"`);
  const listed = wrangler(['d1', 'list', '--json'], { capture: true }).out;
  let id = findDatabase(listed, name);
  let pinned = null;
  if (id) {
    console.log(`  using database ${name} (${id})`);
    pinned = databaseJurisdiction(listed, name);
    if (jurisdiction && pinned !== jurisdiction) console.log(`  note: --jurisdiction ${jurisdiction} applies to new databases only; Cloudflare can't move this one`);
  } else {
    // stdin closed: Wrangler then answers no to adding the database to the config, which names it already.
    const created = wrangler(['d1', 'create', name, ...(jurisdiction ? ['--jurisdiction', jurisdiction] : [])], { capture: true, stdin: 'ignore' });
    id = findDatabase(wrangler(['d1', 'list', '--json'], { capture: true }).out, name);
    if (!id) fail(`Could not create or find the D1 database "${name}":\n${created.out}`);
    console.log(`  created database ${name} (${id})${jurisdiction ? ` in jurisdiction ${jurisdiction}` : ''}`);
    pinned = jurisdiction;
  }
  if (pinned) {
    const from = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
    const text = readFileSync(from, 'utf8');
    const updated = writeVar(text, 'DATA_JURISDICTION', pinned);
    if (updated !== text || from !== LOCAL_CONFIG) {
      writeFileSync(LOCAL_CONFIG, updated);
      console.log(`  DATA_JURISDICTION=${pinned} written to ${LOCAL_CONFIG} (gitignored)`);
    }
  }

  step('Preparing the secrets');
  const password = process.env.ADMIN_PASSWORD
    ? { value: process.env.ADMIN_PASSWORD, path: 'ADMIN_PASSWORD', created: false }
    : secret('admin-password', () => randomBytes(18).toString('base64url'));
  const session = secret('session-secret', () => randomBytes(32).toString('base64url'));
  console.log(`  admin password: ${password.path}${password.created ? ' (new)' : ''}`);
  console.log(`  session secret: ${session.path}${session.created ? ' (new)' : ''}`);

  step('Building the dashboard');
  if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) fail('The build failed.');

  step('Applying the database migrations');
  if (!wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']).ok) fail('The migrations failed.');

  step('Deploying the Worker');
  const dir = mkdtempSync(join(tmpdir(), 'founderdata-'));
  const secretsFile = join(dir, 'secrets.json');
  writeFileSync(secretsFile, JSON.stringify({ ADMIN_PASSWORD: password.value, SESSION_SECRET: session.value }), { mode: 0o600 });
  let result;
  try {
    result = await deploy(secretsFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!result.ok) fail('The deploy failed. If Wrangler printed `fetch failed` or a Cloudflare API error, run `npm run setup` again.');

  const url = result.out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  console.log('\n✓ FounderData is live.');
  if (url) console.log(`  Dashboard: ${url}`);
  console.log(`  Password:  ${password.path === 'ADMIN_PASSWORD' ? 'the ADMIN_PASSWORD you set' : `cat ${password.path}`}`);
  console.log('  Next: log in, add a website and paste its script tag into your site.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.message));
}
