#!/usr/bin/env node
// Smoke-test the single-file bundle the way the Artifact host will run it:
// wrapped in a document the page did not write, with no network of any kind.
//
//   node tools/bundle-check.mjs [--file dist/saltyfin.html] [--shot shots/bundle.png]
//
// Fails on any console error, on a request to anything other than the page
// itself (which would mean the bundle is not self-contained), or on a blank
// frame. Exits non-zero so it can gate a publish.

import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const FILE = resolve(ROOT, opt('file', 'dist/saltyfin.html'));
const SHOT = opt('shot', 'shots/bundle.png');
const WAIT = +opt('wait', 14000);
const W = +opt('w', 900), H = +opt('h', 506);
const MOBILE = args.includes('--mobile');

const fragment = await readFile(FILE, 'utf8');
const doc = `<!doctype html><html><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;

const external = [];
const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(doc);
  } else {
    external.push(req.url);
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}
const { chromium, devices } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const ctxOpts = MOBILE
  ? { ...devices['iPhone 13'], deviceScaleFactor: 1 }
  : { viewport: { width: W, height: H }, deviceScaleFactor: 1 };
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message).slice(0, 600)));
page.on('requestfailed', (r) => { if (!r.url().includes('127.0.0.1')) external.push(r.url()); });

await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.saltyfin?.frames > 1, null, { timeout: 90000 });
} catch { errors.push('no frames rendered within 90s'); }
await page.waitForTimeout(WAIT);

const stats = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 200; s.height = Math.max(1, Math.round(200 * c.height / c.width));
  const g = s.getContext('2d');
  g.drawImage(c, 0, 0, s.width, s.height);
  const d = g.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < d.length; i += 4) v += ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) - mean) ** 2;
  return {
    meanLuma: +mean.toFixed(2), stdLuma: +Math.sqrt(v / n).toFixed(2),
    frames: window.saltyfin?.frames ?? 0,
    tier: window.saltyfin?.quality?.tier ?? '?',
    touch: !!document.getElementById('touch'),
    hud: !!document.querySelector('#hud *'),
  };
});

await mkdir(dirname(join(ROOT, SHOT)), { recursive: true });
await page.screenshot({ path: join(ROOT, SHOT) });
await browser.close();
server.close();

const ok = errors.length === 0 && external.length === 0 && stats.frames > 1 && stats.stdLuma > 1;
console.log(JSON.stringify({ ok, file: FILE, sizeKB: +(fragment.length / 1024).toFixed(0), ...stats, external, errors }, null, 2));
process.exit(ok ? 0 : 1);
