import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The repository is public. These checks keep one deployment's details out of the tracked files (AGENTS.md, "Open
// source"). Words only your deployment uses (a host, a product, a username) go in .private-words, one per line; that
// file is gitignored, so the list itself stays private.

const ROOT = path.resolve(__dirname, '..');
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?)$/i;
const SKIP = new Set(['package-lock.json']);

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !BINARY.test(f) && !SKIP.has(f) && existsSync(path.join(ROOT, f)));
const files = tracked.map((f) => ({ f, text: readFileSync(path.join(ROOT, f), 'utf8') }));

const hits = (re: RegExp) =>
  files.flatMap(({ f, text }) => text.split('\n').flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])));

describe('open source hygiene', () => {
  it('wrangler.jsonc pins no account or database', () => {
    const config = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
    expect(config).not.toMatch(/"(database_id|account_id)"\s*:/);
  });

  it('no tracked file names a home directory', () => {
    expect(hits(/\/(Users|home)\/[a-z0-9_.-]+\//i)).toEqual([]);
  });

  it('no tracked file names a real workers.dev host', () => {
    expect(hits(/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i).filter((h) => !h.includes('<your-subdomain>'))).toEqual([]);
  });

  it('no tracked file uses a word from .private-words', () => {
    const list = path.join(ROOT, '.private-words');
    const words = existsSync(list)
      ? readFileSync(list, 'utf8').split('\n').map((w) => w.trim()).filter((w) => w && !w.startsWith('#'))
      : [];
    for (const w of words) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      expect(hits(re), `"${w}" from .private-words`).toEqual([]);
    }
  });
});
