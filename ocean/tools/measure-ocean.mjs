#!/usr/bin/env node
// Headless spectrum probe. Runs the sim for a few seconds, then reads back the
// assembled fields and prints Hs / mss / whitecap coverage per cascade so the
// wave field can be checked against textbook numbers instead of by eye.
//
//   node tools/measure-ocean.mjs --preset "Golden Hour Swell" --set windSpeed=9.5

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean);
  for (const c of candidates) { try { return await import(c); } catch { /* next */ } }
  throw new Error('playwright not found');
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const multi = (n) => args.reduce((a, v, i) => (v === '--' + n ? [...a, args[i + 1]] : a), []);
const PRESET = opt('preset', 'Golden Hour Swell');
const WAIT = +opt('wait', 6000);
const OVERRIDES = multi('set');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/?preset=${encodeURIComponent(PRESET)}`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => !!window.abyssal, null, { timeout: 30000 });
} catch {
  console.error(errors.join('\n---\n').slice(0, 4000));
  await browser.close(); server.close();
  process.exit(1);
}
await page.evaluate((ov) => {
  const A = window.abyssal;
  for (const kv of ov) {
    const [k, v] = kv.split('=');
    A.params[k] = v.startsWith('[') ? JSON.parse(v) : (isNaN(+v) ? v : +v);
  }
  A.ocean.dirty = true;
  A.ui.syncAll();
}, OVERRIDES);
await page.waitForTimeout(WAIT);

const out = await page.evaluate(() => {
  const A = window.abyssal;
  const p = A.params;
  const m = A.ocean.measure();
  const U = p.windSpeed;
  const g = 9.80665;
  const chi = Math.min(g * p.fetch * 1000 / (U * U), 2.2e4);
  return {
    windSpeed: U, fetch: p.fetch, swellAmount: p.swellAmount,
    HsTheory: +(0.0016 * Math.sqrt(chi) * U * U / g).toFixed(3),
    mssCoxMunk: +(0.003 + 5.12e-3 * U).toFixed(4),
    whitecapMonahan: +(3.84e-6 * Math.pow(U, 3.41)).toFixed(4),
    ...m,
  };
});
await browser.close();
server.close();
console.log(JSON.stringify({ preset: PRESET, errors: errors.slice(0, 6), ...out }, null, 2));
