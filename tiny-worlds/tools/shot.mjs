#!/usr/bin/env node
// Headless capture + validation harness.
//
//   node tools/shot.mjs --out shots/frame.png --w 1280 --h 720 \
//        --seed 1337 --dives 3 --wait 1500
//
// Loads the game with ?autostart=1, optionally dives N rifts deep, then
// screenshots. Exits non-zero on any JS error so it doubles as a smoke test.
// Prints a JSON report (errors, world state, image statistics) on stdout.

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
    try { return await import(c); } catch { /* try next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};

const OUT = opt('out', 'shots/frame.png');
const WAIT = +opt('wait', 1500);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const SEED = opt('seed', '1337');
const DIVES = +opt('dives', 0);
const MIDDIVE = args.includes('--middive'); // screenshot mid-transition
const SURFACE = args.includes('--surface'); // climb one level back out first

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
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(SEED)}&autostart=1`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => window.TW && window.TW.debug && window.TW.debug.state().started, null, { timeout: 10000 });
} catch {
  errors.push('TW.debug never appeared - startup failed');
}

const path = [];
if (!errors.length) {
  path.push(await page.evaluate(() => window.TW.debug.state()));
  for (let i = 0; i < DIVES; i++) {
    await page.evaluate(() => window.TW.debug.dive(0));
    try {
      await page.waitForFunction(() => window.TW.debug.state().mode === 'idle' && window.TW.debug.state().depth > 0, null, { timeout: 6000 });
      await page.waitForFunction((want) => window.TW.debug.state().depth === want, i + 1, { timeout: 6000 });
    } catch {
      errors.push(`dive ${i + 1} never completed`);
      break;
    }
    path.push(await page.evaluate(() => window.TW.debug.state()));
  }
}

if (SURFACE && !errors.length) {
  const before = await page.evaluate(() => window.TW.debug.state().depth);
  await page.evaluate(() => window.TW.debug.surface());
  try {
    await page.waitForFunction((want) => {
      const s = window.TW.debug.state();
      return s.mode === 'idle' && s.depth === want;
    }, before - 1, { timeout: 6000 });
  } catch {
    errors.push('surface never completed');
  }
}
if (MIDDIVE && !errors.length) {
  await page.evaluate(() => window.TW.debug.dive(0));
  await page.waitForTimeout(700);
} else {
  await page.waitForTimeout(WAIT);
}

const stats = await page.evaluate(() => {
  const c = document.getElementById('c');
  const s = document.createElement('canvas');
  s.width = 220; s.height = Math.max(1, Math.round(220 * c.height / c.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, n = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
    n++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  return {
    meanLuma: +mean.toFixed(2),
    stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    meanSat: +(sat / n).toFixed(3),
    state: window.TW.debug.state(),
  };
});

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });

await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.stdLuma > 1.0,
  out: OUT, seed: SEED, dives: DIVES,
  ...stats,
  path: path.map((p) => `${p.depth}: ${p.title} [${p.theme}]`),
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: render produced almost no variation.');
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
