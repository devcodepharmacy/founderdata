#!/usr/bin/env node
// Runs wrangler with wrangler.local.jsonc when that file exists, else wrangler.jsonc. The local file is gitignored and
// holds one deployment's own settings (a pinned database_id, another database name), so the committed config stays
// generic. Usage: node scripts/wrangler.mjs <wrangler args>
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const config = existsSync('wrangler.local.jsonc') ? 'wrangler.local.jsonc' : 'wrangler.jsonc';
const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin/wrangler.js');
const { status } = spawnSync(process.execPath, [bin, ...process.argv.slice(2), '--config', config], { stdio: 'inherit' });
process.exit(status ?? 1);
