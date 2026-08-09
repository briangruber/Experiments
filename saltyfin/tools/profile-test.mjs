#!/usr/bin/env node
// Drives the on-device profiler headlessly so the harness itself can be
// verified. There is no WebGPU in this container, so this only ever exercises
// the WebGL backend — the counters stay at zero and the timings are
// SwiftShader's, not a phone's. What it proves is that the ladder runs every
// rung, produces a report, and does not throw.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUERY = process.argv[2] || 'preset=day&quality=low&profile=1';

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

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')
  .catch(() => import('playwright'));
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${server.address().port}/?${QUERY}`, { waitUntil: 'load' });
const ok = await page.waitForFunction(() => window.saltyfinProfile, null, { timeout: 300000 })
  .then(() => true).catch(() => false);

if (ok) console.log(await page.evaluate(() => window.saltyfinProfile.text));
else console.log('NO PROFILE — frames:', await page.evaluate(() => window.saltyfin?.frames));

await page.screenshot({ path: join(ROOT, 'shots/profile-panel.png') });
if (errors.length) console.error('\nerrors:\n' + errors.slice(0, 8).join('\n'));
await browser.close();
server.close();
