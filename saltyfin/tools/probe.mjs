#!/usr/bin/env node
// Boot the scene headlessly and print an expression evaluated inside the page.
// For the questions a screenshot cannot answer.
//
//   node tools/probe.mjs "JSON.stringify(saltyfin.lights.keyLight.shadow.camera)"
//   node tools/probe.mjs --query "preset=day&quality=med" "saltyfin.quality.shadowSize"

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const qi = args.indexOf('--query');
const QUERY = qi >= 0 ? args[qi + 1] : 'preset=day&quality=med';
const EXPR = args.filter((a, i) => a !== '--query' && i !== qi + 1).join(' ');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, url === '/' ? 'index.html' : url);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                   '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${server.address().port}/?${QUERY}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.saltyfin?.frames > 2, null, { timeout: 90000 }).catch(() => {});
const out = await page.evaluate((e) => {
  try { return String(eval(e)); } catch (err) { return 'EVAL ERROR: ' + err.message; }
}, EXPR);

console.log(out);
if (errors.length) console.error('\nerrors:\n' + errors.slice(0, 6).join('\n'));
await browser.close();
server.close();
