#!/usr/bin/env node
// Capture harness for the Salty Fin Bay prototype.
//
//   node tools/harbor-shot.mjs --out shots/bay.png --wait 3000
//   node tools/harbor-shot.mjs --pose "-26,14,1.35" --hold KeyW --wait 4000
//
// Exits non-zero on any JS/WebGL error, so it doubles as the smoke test. This
// box has no GPU - WebGL runs on SwiftShader at a few frames a second - so
// judge look here, never framerate.

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
const multi = (n) => args.reduce((a, v, i) => (v === '--' + n ? [...a, args[i + 1]] : a), []);

const OUT = opt('out', 'shots/harbor.png');
const WAIT = +opt('wait', 3500);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const QUALITY = opt('quality', '0.6');
const POSE = opt('pose', '');
const HOLD = multi('hold');
const PRESS = multi('press');
const TIME = opt('t', '20');

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

const url = `http://127.0.0.1:${port}/harbor/index.html?nointro=1&${opt("extra","")}&quality=${QUALITY}&t=${TIME}`;
await page.goto(url, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.bay, null, { timeout: 30000 });
} catch {
  errors.push('window.bay never appeared - startup failed');
}

if (!errors.length) {
  if (POSE) {
    const [x, z, yaw] = POSE.split(',').map(Number);
    await page.evaluate(([x, z, yaw]) => { window.bay.setPose(x, z, yaw); window.bay.snapCamera(); }, [x, z, yaw]);
  }
  for (const k of HOLD) await page.evaluate((k) => window.bay.hold(k, true), k);
  for (const k of PRESS) await page.evaluate((k) => window.bay.press(k), k);
}

await page.waitForTimeout(WAIT);

const stats = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 240; s.height = Math.max(1, Math.round(240 * c.height / c.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, sat = 0, n = 0, min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; min = Math.min(min, l); max = Math.max(max, l);
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
    meanLuma: +mean.toFixed(2), stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1),
    meanSat: +(sat / n).toFixed(3),
    frames: window.bay?.frames ?? 0,
    coins: window.bay?.fishing?.coins ?? 0,
    state: window.bay?.fishing?.state ?? '?',
    boat: window.bay ? [ +window.bay.boat.x.toFixed(1), +window.bay.boat.z.toFixed(1), +window.bay.boat.speed.toFixed(2) ] : null,
  };
});

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });
await browser.close();
server.close();

const report = { ok: errors.length === 0 && stats.stdLuma > 1.0, out: OUT, ...stats, errors: errors.slice(0, 10) };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
