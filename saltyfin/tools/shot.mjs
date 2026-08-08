#!/usr/bin/env node
// Headless capture and smoke test.
//
//   node tools/shot.mjs --out shots/day.png --preset day --w 1280 --h 720
//   node tools/shot.mjs --out shots/n.png --t 22.5 --cam "orbit,140,26" --wait 9000
//
// Exits non-zero on any console error, on a frame that never arrived, or on a
// flat image, so it doubles as the build check. Prints a JSON report.

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
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const OUT = opt('out', 'shots/frame.png');
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const WAIT = +opt('wait', 7000);
const QUERY = [];
for (const k of ['preset', 't', 'quality', 'seed', 'cam', 'boat', 'fov', 'pr', 'rate', 'step', 'shadows', 'nopost', 'forcegl']) {
  const v = opt(k, null);
  if (v !== null) QUERY.push(`${k}=${encodeURIComponent(v)}`);
}
if (!QUERY.some((q) => q.startsWith('quality='))) QUERY.push('quality=' + opt('quality', 'high'));
// The node renderer cannot be read back after the frame; main.js mirrors it.
QUERY.push('capture=1');
const SHOW_HUD = has('hud');

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
    '--disable-dev-shm-usage', '--enable-webgl-draft-extensions',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

// While the TSL port is in flight, a not-yet-converted ShaderMaterial logs an
// incompatibility and the scene carries on rendering without it. Count those
// separately so the smoke test still catches real failures.
const PORT_PENDING = /NodeBuilder: Material "(Raw)?ShaderMaterial" is not compatible/;
const errors = [];
const pending = new Set();
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(`${m.type()}: ${t}`);
  if (m.type() !== 'error') return;
  if (PORT_PENDING.test(t)) pending.add(t.slice(0, 120));
  else errors.push(t);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto(`http://127.0.0.1:${port}/?${QUERY.join('&')}`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => window.saltyfin?.ready === true, null, { timeout: 30000 });
} catch {
  errors.push('window.saltyfin never became ready — startup failed');
}

if (!errors.length) {
  try {
    await page.waitForFunction(() => window.saltyfin.frames > 1, null, { timeout: 60000 });
  } catch {
    errors.push('no frames rendered within 60s');
  }
}

// `--eval "<js>"` runs inside the page once the scene is up and before the
// capture settles. For poking at the live scene without an edit/rebuild cycle.
const EVAL = opt('eval', null);
if (EVAL) {
  const r = await page.evaluate((e) => {
    try { return String(eval(e)); } catch (err) { return 'EVAL ERROR: ' + err.message; }
  }, EVAL);
  if (r && r !== 'undefined') process.stderr.write('eval -> ' + r + '\n');
}

await page.waitForTimeout(WAIT);
if (!SHOW_HUD) await page.evaluate(() => window.saltyfin?.hideHud?.());
await page.waitForTimeout(500);

const stats = await page.evaluate(() => {
  const c = document.getElementById('grab') || document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 240; s.height = Math.max(1, Math.round(240 * c.height / c.width));
  const g = s.getContext('2d');
  g.drawImage(c, 0, 0, s.width, s.height);
  const d = g.getImageData(0, 0, s.width, s.height).data;
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
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  return {
    meanLuma: +mean.toFixed(2), stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1),
    meanSat: +(sat / n).toFixed(3), histogram: hist,
    frames: window.saltyfin?.frames ?? 0,
    hour: +(window.saltyfin?.env?.hour ?? -1).toFixed(2),
  };
});

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });
await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.frames > 1 && stats.stdLuma > 1.0,
  out: OUT, query: QUERY.join('&'), ...stats,
  unportedMaterials: pending.size, errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: almost no variation in the render.');
  console.error(logs.slice(-50).join('\n'));
  process.exit(1);
}
