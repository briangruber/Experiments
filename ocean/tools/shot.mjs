#!/usr/bin/env node
// Headless capture + validation harness.
//
//   node tools/shot.mjs --out shots/a.png --preset "North Atlantic Storm" \
//        --wait 4000 --w 1280 --h 720 --set exposureBias=0.3 --set fov=30
//
// Exits non-zero on any WebGL/JS error so it doubles as a smoke test. Prints a
// JSON report (errors, fps, frame count, image statistics) on stdout.

import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
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
const multi = (name) => args.reduce((a, v, i) => (v === '--' + name ? [...a, args[i + 1]] : a), []);

const OUT = opt('out', 'shots/frame.png');
const PRESET = opt('preset', 'Golden Hour Swell');
const WAIT = +opt('wait', 4000);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const OVERRIDES = multi('set');
const CAMERA = opt('camera', '');
const PHOTO = args.includes('--photo');

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
  const t = m.text();
  logs.push(`${m.type()}: ${t}`);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto(`http://127.0.0.1:${port}/?preset=${encodeURIComponent(PRESET)}`, { waitUntil: 'load' });

// Wait for the module to publish its handle (or fail loudly).
try {
  await page.waitForFunction(() => !!window.abyssal, null, { timeout: 20000 });
} catch {
  errors.push('window.abyssal never appeared - startup failed');
}

if (!errors.length) {
  await page.evaluate(([overrides, camera]) => {
    const A = window.abyssal;
    for (const kv of overrides) {
      const [k, v] = kv.split('=');
      A.params[k] = v.startsWith('[') ? JSON.parse(v) : (isNaN(+v) ? v : +v);
    }
    if (camera) {
      const [x, y, z, yaw, pitch] = camera.split(',').map(Number);
      A.camera.pos[0] = x; A.camera.pos[1] = y; A.camera.pos[2] = z;
      A.camera.yaw = yaw; A.camera.pitch = pitch;
    }
    A.ocean.dirty = true;
    A.ui.syncAll();
  }, [OVERRIDES, CAMERA]);
}

await page.waitForTimeout(WAIT);
if (PHOTO) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' })));
  await page.waitForTimeout(6000);
}
await page.evaluate(() => document.getElementById('ui').classList.add('hidden'));
await page.waitForTimeout(400);

const stats = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 220; s.height = Math.max(1, Math.round(220 * c.height / c.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, min = 255, max = 0, sat = 0, n = 0;
  const hist = new Array(16).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; min = Math.min(min, l); max = Math.max(max, l);
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
    hist[Math.min(15, Math.floor(l / 16))]++;
    n++;
  }
  let varSum = 0;
  const mean = sum / n;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  return {
    meanLuma: +mean.toFixed(2),
    stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1),
    meanSat: +(sat / n).toFixed(3),
    histogram: hist,
    frames: window.abyssal?.frames ?? 0,
    fps: document.getElementById('hud-fps')?.textContent ?? '',
  };
});

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
// Full-viewport capture: the canvas fills it, and element screenshots stall
// waiting for "stability" on a surface that is animating every frame.
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });

await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.frames > 2 && stats.stdLuma > 1.0,
  out: OUT, preset: PRESET, ...stats,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: render produced almost no variation.');
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
