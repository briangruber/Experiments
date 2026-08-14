#!/usr/bin/env node
// Contact sheet of the generated props. Loads each GLB, frames it on its own
// bounding box and shoots it three-quarter front, so a look at one PNG answers
// whether a generated asset belongs in this set at all.
//
//   node tools/preview-assets.mjs --out shots/assets.png

import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'shots/assets.png');
const CELL = 320;

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
const port = server.address().port;

const files = (await readdir(join(ROOT, 'assets'))).filter((f) => f.endsWith('.glb')).sort();
const cols = Math.ceil(Math.sqrt(files.length));
const rows = Math.ceil(files.length / cols);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: cols * CELL, height: rows * CELL }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', (e.stack || e.message).slice(0, 400)));
await page.goto(`http://127.0.0.1:${port}/tools/preview-assets.html`, { waitUntil: 'load' });
const info = await page.evaluate(
  ([f, c, cell]) => window.__preview(f, c, cell),
  [files, cols, CELL],
);
await mkdir(join(ROOT, dirname(OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT) });
await browser.close();
server.close();
console.log(JSON.stringify(info, null, 2));
