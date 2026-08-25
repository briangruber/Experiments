#!/usr/bin/env node
// Look at a cast model the way the show will: full figure, three-quarter, and
// the face close-up that decides whether it can act.
//
//   node tools/cast-preview.mjs company/cast/models/src/esteban.glb
//   node tools/cast-preview.mjs --out shots/cast-ab.png \
//     "v2.5=company/cast/models/src/v25/esteban.glb" "v3.0=company/cast/models/src/esteban.glb"
//
// One row per model, three angles across. Labels are optional (`label=path`).
// Prints geometry, texture sizes, bone count and clip list per model, which is
// what tells you whether a mesh is riggable-looking and how much of the bundle
// budget it is about to eat.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'shots/cast-preview.png');
const CELL = +opt('cell', 420);

const items = args.filter((a) => !a.startsWith('--') && a !== OUT && a !== String(CELL))
  .map((a) => {
    const eq = a.indexOf('=');
    const label = eq > 0 ? a.slice(0, eq) : basename(a).replace('.glb', '');
    const file = eq > 0 ? a.slice(eq + 1) : a;
    return { label, url: '/' + file.replace(/^\/+/, '') };
  });
if (!items.length) { console.error('usage: node tools/cast-preview.mjs [label=]<path.glb> ...'); process.exit(1); }

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  viewport: { width: 3 * CELL, height: items.length * CELL }, deviceScaleFactor: 1,
});
page.on('pageerror', (e) => console.error('page error:', (e.stack || e.message).slice(0, 400)));
await page.goto(`http://127.0.0.1:${server.address().port}/tools/cast-preview.html`, { waitUntil: 'load' });
const info = await page.evaluate(([i, c]) => window.__preview(i, c), [items, CELL]);
await mkdir(join(ROOT, dirname(OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT) });
await browser.close();
server.close();
console.log(JSON.stringify(info, null, 2));
console.log(`\n-> ${OUT}`);
