#!/usr/bin/env node
// Headless capture + smoke test.
//
//   node tools/shot.mjs --out shots/a.png --scene 2 --at 14 --w 1280 --h 720
//   node tools/shot.mjs --contact shots/contact          # one frame per beat
//
// Exits non-zero on any WebGL/JS error or on a flat/black frame, so it works
// as the test suite for this prototype.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};

const OUT = opt('out', 'shots/frame.png');
const SCENE = +opt('scene', 0);
const AT = +opt('at', 6);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const CONTACT = opt('contact', null);
const NO_UI = !args.includes('--ui');

// One frame from each act, chosen to land on a beat worth looking at.
const CONTACT_SHEET = [
  [0, 3], [0, 20], [0, 27],
  [1, 6], [1, 14], [1, 26], [1, 39],
  [2, 10], [2, 16.5], [2, 22], [2, 28], [2, 34],
  [3, 5], [3, 14.2], [3, 18], [3, 27],
  [4, 8], [4, 14], [4, 20], [4, 27], [4, 40],
  [5, 6], [5, 13], [5, 29], [5, 35], [5, 40],
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
    '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 25000 });
} catch {
  errors.push('window.__telenovela never appeared — startup failed');
}

// Sampling happens inside the page's own render frame — see main.js.
async function measure() {
  return page.evaluate(() => window.__telenovela.measure());
}

async function seek(scene, at) {
  await page.evaluate(([s, t]) => window.__telenovela.goTo(s, t), [scene, at]);
  // A few real frames so the springs settle and the render targets fill.
  await page.waitForTimeout(420);
}

const results = [];
if (!errors.length) {
  await page.evaluate(() => {
    window.__telenovela.score.setEnabled(false);
    document.getElementById('start').classList.add('gone');
  });
  if (NO_UI) await page.evaluate(() => document.body.classList.add('no-ui'));

  const FRAMES = opt('frames', null);   // e.g. --frames 0:3,2:16.5,5:35
  const list = FRAMES
    ? FRAMES.split(',').map((p) => p.split(':').map(Number))
    : CONTACT ? CONTACT_SHEET : [[SCENE, AT]];
  for (let i = 0; i < list.length; i++) {
    const [s, t] = list[i];
    await seek(s, t);
    const stats = await measure();
    const out = list.length > 1
      ? join(CONTACT || dirname(OUT), `${String(i).padStart(2, '0')}-s${s}-t${String(t).replace('.', '_')}.png`)
      : OUT;
    await mkdir(dirname(join(ROOT, out)), { recursive: true });
    await page.screenshot({ path: join(ROOT, out), timeout: 60000, animations: 'disabled' });
    results.push({ out, scene: s, at: t, ...stats });
  }
}

await browser.close();
server.close();

const lit = results.filter((r) => r.stdLuma > 2 && r.maxLuma > 24);
const report = {
  ok: errors.length === 0 && results.length > 0 && lit.length === results.length,
  frames: results.length,
  lit: lit.length,
  results,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length) console.error('\nDARK/FLAT FRAMES: ' + results.filter((r) => !lit.includes(r)).map((r) => r.out).join(', '));
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
