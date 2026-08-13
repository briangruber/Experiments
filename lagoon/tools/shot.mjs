#!/usr/bin/env node
// Headless capture + validation harness for the lagoon prototype.
//
//   node tools/shot.mjs --out shots/a.png --preset "Midday Cove" --wait 4000 \
//        --w 1280 --h 720 --set waveHeight=0.35 --view postcard
//
// Exits non-zero on any JS/GPU error, so it doubles as a smoke test. Prints a
// JSON report (errors, frames, image statistics) on stdout.
//
// Two things about headless Chromium shape this tool. WebGPU is only exposed
// behind --enable-unsafe-webgpu and comes from a software adapter, so rendering
// is seconds per frame rather than milliseconds; and the device is lost the
// moment anything is presented to a canvas. So the page is loaded with
// ?offscreen=1, which stops it drawing to the canvas, and frames are pulled
// through window.lagoon.capture(), which renders into a texture and reads it
// back. That path exercises the real WebGPU backend. Pass --webgl to run the
// same scene through three's WebGL fallback instead, which is worth doing
// before shipping since that is what a browser without WebGPU will see.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
const PRESET = opt('preset', '');
const VIEW = opt('view', '');
const WAIT = +opt('wait', 6000);
// WebGPU texture readback pads rows to 256 bytes, so a capture width that is
// not a multiple of 64 pixels comes back sheared. Round up rather than produce
// a picture that is subtly wrong.
const ALIGN = (v) => Math.ceil(v / 64) * 64;
const WIDTH = ALIGN(+opt('w', 1280));
const HEIGHT = +opt('h', 720);
const OVERRIDES = multi('set');
const FORCE_GL = args.includes('--webgl');
const NO_POST = args.includes('--no-post');
const QUALITY = opt('q', '');
// --onscreen drives the ordinary canvas path instead of the offscreen capture,
// which is the code a browser actually runs. Only usable with --webgl here:
// headless WebGPU loses its device the moment it presents to a canvas.
const ONSCREEN = args.includes('--onscreen');

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
    '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
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

const query = new URLSearchParams();
if (PRESET) query.set('preset', PRESET);
if (VIEW) query.set('view', VIEW);
if (FORCE_GL) query.set('webgl', '1');
if (QUALITY) query.set('q', QUALITY);
if (NO_POST) query.set('post', '0');
if (!ONSCREEN) query.set('offscreen', '1');
query.set('ui', '0');
await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.lagoon, null, { timeout: 60000 });
} catch {
  errors.push('window.lagoon never appeared - startup failed');
}

if (!errors.length && OVERRIDES.length) {
  await page.evaluate((overrides) => {
    for (const kv of overrides) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      window.lagoon.set(k, v.startsWith('#') || isNaN(+v) ? v : +v);
    }
  }, OVERRIDES);
}

await page.waitForTimeout(WAIT);

let dataUrl = null;
page.setDefaultTimeout(300000);
if (!errors.length) {
  try {
    dataUrl = ONSCREEN
      ? 'data:image/png;base64,' + (await page.screenshot({ timeout: 300000 })).toString('base64')
      : await page.evaluate(() => window.lagoon.capture());
  } catch (e) {
    errors.push('capture failed: ' + String(e).slice(0, 300));
  }
}

const stats = await page.evaluate(async (url) => {
  const empty = { meanLuma: 0, stdLuma: 0, minLuma: 0, maxLuma: 0, meanSat: 0, histogram: [] };
  const L = window.lagoon;
  const base = {
    backend: L?.backend ?? '?',
    frames: L?.frames ?? 0,
    camera: L ? L.camera.position.toArray().map((v) => +v.toFixed(2)) : null,
    target: L ? L.orbit.target.toArray().map((v) => +v.toFixed(2)) : null,
  };
  if (!url) return { ...empty, ...base };
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const s = document.createElement('canvas');
  s.width = 240; s.height = Math.max(1, Math.round((240 * img.height) / img.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(img, 0, 0, s.width, s.height);
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
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  return {
    ...base,
    meanLuma: +mean.toFixed(2),
    stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1),
    meanSat: +(sat / n).toFixed(3),
    histogram: hist,
    size: [img.width, img.height],
  };
}, dataUrl);

if (dataUrl) {
  await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
  await writeFile(join(ROOT, OUT), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.frames > 2 && stats.stdLuma > 1.0,
  out: OUT, preset: PRESET || '(default)', ...stats,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: render produced almost no variation.');
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
