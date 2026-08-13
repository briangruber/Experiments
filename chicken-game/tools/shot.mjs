#!/usr/bin/env node
// Headless capture + smoke test for the chicken coop.
//
//   node tools/shot.mjs --out shots/coop.png --wait 5000 --w 1280 --h 720
//
// Exits non-zero on any JS/WebGL error, a stalled render loop, or a flat
// image. Prints a JSON report (errors, frames, image statistics) on stdout.

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

const OUT = opt('out', 'shots/coop.png');
const WAIT = +opt('wait', 5000);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const SEED = opt('seed', '7');

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
    '--disable-dev-shm-usage',
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

await page.goto(`http://127.0.0.1:${port}/?seed=${SEED}`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.chickenGame, null, { timeout: 20000 });
} catch {
  errors.push('window.chickenGame never appeared - startup failed');
}

const FF = +opt('ff', 0); // fast-forward N simulation steps (1/30 s each)
if (FF > 0 && !errors.length) {
  await page.evaluate((n) => window.chickenGame.step(n), FF);
}

const CAM = opt('camera', ''); // "theta,phi,r"
if (CAM && !errors.length) {
  await page.evaluate((cam) => {
    const [theta, phi, r] = cam.split(',').map(Number);
    const o = window.chickenGame.orbit;
    o.theta = o.thetaT = theta;
    o.phi = o.phiT = phi;
    o.r = o.rT = r;
    o.lastInput = window.chickenGame.world.time; // suppress idle drift
  }, CAM);
}

await page.waitForTimeout(WAIT);

const stats = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 220; s.height = Math.max(1, Math.round(220 * c.height / c.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, min = 255, max = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; min = Math.min(min, l); max = Math.max(max, l);
    n++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  const g = window.chickenGame;
  return {
    meanLuma: +mean.toFixed(2),
    stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1),
    frames: g?.frames ?? 0,
    chickens: g?.world.chickens.filter((ch) => ch.active).length ?? 0,
    chicks: g?.world.chicks.filter((k) => k.active).length ?? 0,
    behaviors: g?.world.chickens.filter((ch) => ch.active).map((ch) => ch.bhv.name) ?? [],
    bertha: g?.world.bertha?.bhv.name ?? null,
    eggs: g?.world.eggs.length ?? 0,
  };
});

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });

await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.frames > 2 && stats.stdLuma > 1.0
    && stats.chickens >= 8 && !!stats.bertha,
  out: OUT, ...stats,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: render produced almost no variation.');
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
