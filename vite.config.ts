import react from '@vitejs/plugin-react';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { defineConfig, transformWithEsbuild, type Plugin, type Rollup } from 'vite';

const outDir = resolve(__dirname, 'dist');

/**
 * Every tracked page loads public/js/script.js, so the build serves it minified: the source keeps its comments, the
 * visitor gets about 4 KB gzipped. The /*! header with the license credit stays.
 */
function minifyTracker(): Plugin {
  return {
    name: 'minify-tracker',
    apply: 'build',
    async closeBundle() {
      const file = resolve(outDir, 'js/script.js');
      const src = await readFile(file, 'utf8');
      const out = await transformWithEsbuild(src, file, { minify: true, legalComments: 'inline', target: 'es2017', format: undefined });
      await writeFile(file, out.code);
    },
  };
}

/**
 * FounderData Pro's scripts for tracked pages (docs/PRO.md): each pro/js/<name>.ts is bundled on its own into
 * dist/js/<name>.js, so it is a free static file next to script.js. The recorder pro/js/replay.ts becomes /js/replay.js,
 * which the tracker loads only for visits the server picks to record. Core has no pro/ folder, so this does nothing there.
 */
function proScripts(): Plugin {
  const dir = resolve(__dirname, 'pro/js');
  return {
    name: 'pro-scripts',
    apply: 'build',
    async closeBundle() {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir).filter((n) => /^[\w-]+\.ts$/.test(n))) {
        await esbuild({
          entryPoints: [resolve(dir, f)],
          outfile: resolve(outDir, 'js', f.replace(/\.ts$/, '.js')),
          bundle: true,
          minify: true,
          format: 'iife',
          target: 'es2017',
          legalComments: 'inline',
          logLevel: 'warning',
        });
      }
    },
  };
}

/**
 * React and the charts library get chunks of their own: they change with a dependency bump, not with every
 * dashboard edit, so a deploy leaves them cached. Recharts is in no static import of the entry, so it downloads with
 * the first page that draws a chart.
 */
function manualChunks(id: string) {
  if (!id.includes('node_modules')) return undefined;
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
  if (/node_modules\/(recharts|recharts-scale|react-smooth|react-transition-group|victory-vendor|d3-[\w-]+|internmap|lodash|eventemitter3|fast-equals|clsx|tiny-invariant|decimal\.js-light|prop-types|react-is)\//.test(id)) return 'charts';
  return undefined;
}

/**
 * Preload the chunks of the page a visitor lands on. The browser sees the entry script in index.html at once, but a
 * lazy page's chunk is only discovered when the entry runs, a full round trip later. This puts the page's own chunk
 * and its static imports into modulepreload links, written by a three-line inline script that picks them by path,
 * so they download beside the entry. Pages not listed (a section of a site, Login) load from lib/routes.ts as before.
 */
function preloadLandingChunks(): Plugin {
  const landing: [string, string][] = [
    ['^/$', 'pages/Home.tsx'],
    ['^/site/[\\w-]+/settings/?$', 'pages/Settings.tsx'],
    ['^/site/[\\w-]+/?$', 'pages/Dashboard.tsx'],
    ['^/apps/?$', 'pages/Apps.tsx'],
    ['^/notifications/?$', 'pages/Notifications.tsx'],
    ['^/share/', 'pages/SharePage.tsx'],
  ];
  return {
    name: 'preload-landing-chunks',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle || !ctx.chunk) return;
        const chunks = Object.values(bundle).filter((c): c is Rollup.OutputChunk => c.type === 'chunk');
        const byFile = new Map(chunks.map((c) => [c.fileName, c]));
        const closure = (c: Rollup.OutputChunk, seen = new Set<string>()) => {
          if (seen.has(c.fileName)) return seen;
          seen.add(c.fileName);
          for (const f of c.imports) if (byFile.has(f)) closure(byFile.get(f)!, seen);
          return seen;
        };
        const already = closure(ctx.chunk);
        const table = landing.flatMap(([re, module]) => {
          const page = chunks.find((c) => c.facadeModuleId?.endsWith(module));
          if (!page) return [];
          return [[re, [...closure(page)].filter((f) => !already.has(f))] as const];
        });
        const code = `(function(){var p=location.pathname,t=${JSON.stringify(table)};for(var i=0;i<t.length;i++)if(new RegExp(t[i][0]).test(p)){t[i][1].forEach(function(f){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href='/'+f;document.head.appendChild(l)});break}})()`;
        return [{ tag: 'script', children: code, injectTo: 'head' as const }];
      },
    },
  };
}

export default defineConfig({
  root: 'src/dashboard',
  publicDir: '../../public',
  plugins: [react(), minifyTracker(), proScripts(), preloadLandingChunks()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // The entry is held to a budget by scripts/bundle-report.mjs; the rest is one chunk per page and section.
    chunkSizeWarningLimit: 500,
    // Chunks under 8 KB merge into a neighbour: a request costs more than the bytes it saves.
    rollupOptions: { output: { manualChunks, experimentalMinChunkSize: 8_000 } },
  },
  // FD_WEB_PORT and FD_API_PORT move the dev servers, so two checkouts can run side by side.
  server: {
    port: Number(process.env.FD_WEB_PORT ?? 5173),
    proxy: { '/api': `http://localhost:${process.env.FD_API_PORT ?? 8787}`, '/mcp': `http://localhost:${process.env.FD_API_PORT ?? 8787}` },
  },
});
