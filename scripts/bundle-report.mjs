#!/usr/bin/env node
// Prints the dashboard's chunk table after `npm run build` and exits 1 when the entry's JavaScript passes the budget.
//
//   npm run build && npm run bundle:report            budget 90 KB gzip
//   node scripts/bundle-report.mjs --budget=120       another budget (KB, gzip)
//   node scripts/bundle-report.mjs --dist=some/dist   another build folder
//
// "Entry" means the entry chunk plus every chunk it imports statically: the JavaScript a visitor downloads before the
// shell can run. Page and section chunks are lazy and are listed, with the first-load total of the main pages, for
// information only. Sizes are of the files in dist, compressed here the way a CDN would.
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const dist = args.dist ?? 'dist';
const budgetKb = Number(args.budget ?? 90);
const assets = join(dist, 'assets');
if (!existsSync(join(dist, 'index.html')) || !existsSync(assets)) {
  console.error(`No build in ${dist}. Run: npm run build`);
  process.exit(2);
}

const kb = (n) => (n / 1024).toFixed(1).padStart(8);
const files = readdirSync(assets).filter((f) => /\.(js|css)$/.test(f));
const info = new Map();
for (const f of files) {
  const buf = readFileSync(join(assets, f));
  info.set(f, {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    imports: f.endsWith('.js') ? [...buf.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]) : [],
  });
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+)"/.exec(html)?.[1];
if (!entry || !info.has(entry)) {
  console.error('Cannot find the entry script in index.html.');
  process.exit(2);
}

const closure = (start, seen = new Set()) => {
  if (seen.has(start) || !info.has(start)) return seen;
  seen.add(start);
  for (const f of info.get(start).imports) closure(f, seen);
  return seen;
};
const sum = (set, key) => [...set].reduce((a, f) => a + info.get(f)[key], 0);
const entrySet = closure(entry);

console.log(`${'chunk'.padEnd(34)}${'raw KB'.padStart(9)}${'gzip KB'.padStart(9)}${'brotli KB'.padStart(11)}  role`);
for (const [f, i] of [...info].sort((a, b) => b[1].raw - a[1].raw)) {
  const role = f.endsWith('.css') ? 'css' : f === entry ? 'entry' : entrySet.has(f) ? 'entry import' : 'lazy';
  console.log(`${f.padEnd(34)}${kb(i.raw)} ${kb(i.gzip)} ${kb(i.brotli)}   ${role}`);
}

const js = (set) => [...set].filter((f) => f.endsWith('.js'));
console.log('');
console.log(`Entry JS (entry chunk + static imports, ${js(entrySet).length} files): ${(sum(new Set(js(entrySet)), 'raw') / 1024).toFixed(1)} KB raw, ${(sum(new Set(js(entrySet)), 'gzip') / 1024).toFixed(1)} KB gzip, ${(sum(new Set(js(entrySet)), 'brotli') / 1024).toFixed(1)} KB brotli`);
for (const [label, prefix] of [['Home', 'Home-'], ['Site page', 'Dashboard-']]) {
  const page = files.find((f) => f.startsWith(prefix));
  if (!page) continue;
  const all = new Set([...entrySet, ...closure(page)]);
  console.log(`First load of ${label}: ${js(all).length} JS files, ${(sum(new Set(js(all)), 'gzip') / 1024).toFixed(1)} KB gzip, ${(sum(new Set(js(all)), 'brotli') / 1024).toFixed(1)} KB brotli`);
}

const entryGzip = sum(new Set(js(entrySet)), 'gzip') / 1024;
if (entryGzip > budgetKb) {
  console.error(`\nOver budget: the entry JavaScript is ${entryGzip.toFixed(1)} KB gzip, the budget is ${budgetKb} KB. Move code behind a dynamic import (lib/pages.ts) or raise --budget on purpose.`);
  process.exit(1);
}
console.log(`\nWithin budget: ${entryGzip.toFixed(1)} KB of ${budgetKb} KB gzip.`);
