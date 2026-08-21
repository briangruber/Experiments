#!/usr/bin/env node
// Headless capture + validation harness for the fluid tank.
//
//   node tools/shot.mjs --out shots/a.png --q low --wait 6000 --w 1280 --h 720 \
//        --camera 0.5,0.12,3.4 --burst "0,-0.4,0,1.6"
//
// Exits non-zero on any WebGL/JS error so it doubles as a smoke test. Prints a
// JSON report (errors, fps, frame count, image statistics) on stdout.

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
const multi = (name) => args.reduce((a, v, i) => (v === '--' + name ? [...a, args[i + 1]] : a), []);

const OUT = opt('out', 'shots/frame.png');
const QUALITY = opt('q', 'low');
const WAIT = +opt('wait', 6000);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const CAMERA = opt('camera', '');
const BURSTS = multi('burst');
const HIDE_UI = args.includes('--no-ui');
const DTCAP = opt('dtcap', '');
const GPU = args.includes('--gpu');
const BARREL = args.includes('--barrel');
const NO_PADDLE = args.includes('--no-paddle');
const EMIT = args.includes('--emit');   // run the floor bubble diffuser
const FISH = args.includes('--fish');   // bring the easter egg out, mid-approach
const BARREL_TAIL = +opt('barrel-tail', 18000); // ms of sim left after the drop
const BARREL_COUNT = +opt('barrels', 1);
const VIEW = opt('view', '');
const DIAG = args.includes('--diag');
const PARAMS = multi('param');   // --param tank=0.55 (repeatable)

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
// note: --use-angle=swiftshader breaks the WebGPU SwiftShader adapter, so
// the flag sets are disjoint per backend
const browser = await chromium.launch({
  args: GPU ? [
    '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
  ] : [
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

const dtq = DTCAP ? `&dtcap=${encodeURIComponent(DTCAP)}` : '';
const gpq = GPU ? '&gpu=1&present=rt' : '&gpu=0';
const vwq = (VIEW ? `&view=${encodeURIComponent(VIEW)}` : '') + (DIAG ? '&diag=1' : '')
  + PARAMS.map((p) => `&${p}`).join('');
await page.goto(`http://127.0.0.1:${port}/?q=${encodeURIComponent(QUALITY)}${dtq}${gpq}${vwq}`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.water, null, { timeout: 20000 });
} catch {
  errors.push('window.water never appeared - startup failed');
}

if (!errors.length) {
  await page.evaluate(([camera, bursts]) => {
    const W = window.water;
    if (camera) {
      const [az, el, dist] = camera.split(',').map(Number);
      W.camera(az, el, dist);
    }
    for (const b of bursts) {
      const [x, y, z, foam] = b.split(',').map(Number);
      W.burst(x, y, z, foam || 1.5);
    }
  }, [CAMERA, BURSTS]);
  if (NO_PADDLE) await page.evaluate(() => window.water.setPaddleHidden(true));
  if (FISH) {
    await page.evaluate(() => {
      window.water.visitor.begin();
      window.water.visitor.state.t = 0.5;   // step to the apex of the approach
    });
  }
  if (EMIT) {
    await page.evaluate(() => Object.assign(window.water.fluid.emitter,
      { on: true, rate: 4.0, radius: 0.16, jet: 1.4, fx: -0.35 }));
  }
}

// drop late enough that the splash is still developing when we capture
if (BARREL) {
  await page.waitForTimeout(Math.max(WAIT - BARREL_TAIL, 0));
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.water.dropBarrel(); }, BARREL_COUNT);
  await page.waitForTimeout(Math.min(BARREL_TAIL, WAIT));
} else {
  await page.waitForTimeout(WAIT);
}
if (HIDE_UI) await page.evaluate(() => document.body.classList.add('ui-hidden', 'no-chrome'));
// WebGPU canvas presentation doesn't composite in headless Chromium; ask the
// app to read pixels back and blit them onto a capturable 2D canvas.
if (GPU) {
  try { await page.evaluate(() => window.water.captureTo2D()); }
  catch (e) { errors.push('captureTo2D failed: ' + String(e).slice(0, 200)); }
}
await page.waitForTimeout(200);

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
const shotBuffer = await page.screenshot({ path: join(ROOT, OUT), timeout: 180000, animations: 'disabled' });

// Image statistics are computed from the captured PNG (decoded back in the
// page); reading the WebGL canvas directly comes back blank under SwiftShader.
const stats = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const s = document.createElement('canvas');
  s.width = 220; s.height = Math.max(1, Math.round(220 * img.height / img.width));
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
    frames: window.water?.frames ?? 0,
  };
}, shotBuffer.toString('base64'));

await browser.close();
server.close();

const report = {
  ok: errors.length === 0 && stats.frames > 2 && stats.stdLuma > 1.0,
  out: OUT, quality: QUALITY, ...stats,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: render produced almost no variation.');
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
