#!/usr/bin/env node
// Headless capture and smoke test.
//
//   node tools/shot.mjs --out shots/verdance.png --world 0 --wait 3000
//   node tools/shot.mjs --out shots/bloom.png --world 0 --bloom --drive 2
//
// Serves the folder, loads the game with the menu skipped, optionally drives
// the keeper around, screenshots, and exits non-zero on any JS/WebGL error or
// on a frame that came out flat (which is what a failed render looks like).

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
const flag = (n) => args.includes('--' + n);

const OUT = opt('out', 'shots/frame.png');
const WORLD = +opt('world', 0);
const WAIT = +opt('wait', 3200);
const WIDTH = +opt('w', 1440);
const HEIGHT = +opt('h', 810);
const DRIVE = +opt('drive', 0);          // seconds of held W
const KEYS = opt('keys', 'KeyW');
const DIST = opt('dist', '');
const BLOOM = flag('bloom');
const FLIGHT = flag('flight');
const NOHUD = flag('nohud');
const STEP = opt('step', '0.0166');
const FRAMES = +opt('frames', 0);
const MENU = flag('menu');   // leave the title card up instead of skipping it

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg',
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
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
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

await page.goto(`http://127.0.0.1:${port}/?${MENU ? '' : 'skipmenu=1&'}world=${WORLD}&dt=${STEP}`, { waitUntil: 'load' });

// Under software rendering a frame can take seconds, so every wait below is
// expressed in rendered frames, not wall-clock milliseconds.
const waitFrames = async (n) => {
  const start = await page.evaluate(() => window.tinyWorlds?.state.frames ?? 0);
  await page.waitForFunction((target) => (window.tinyWorlds?.state.frames ?? 0) >= target,
    start + n, { timeout: 180000 }).catch(() => errors.push(`stalled waiting for ${n} frames`));
};

const wanted = MENU ? ['title'] : ['play', 'finale'];
try {
  await page.waitForFunction((modes) => !!window.tinyWorlds && modes.includes(window.tinyWorlds.state.mode),
    wanted, { timeout: 60000 });
} catch {
  errors.push(`game never reached ${wanted.join('/')} state`);
}

if (!errors.length) {
  if (DIST) await page.evaluate((d) => { window.tinyWorlds.chase.targetDistance = +d; }, DIST);
  if (BLOOM) await page.evaluate(() => window.tinyWorlds.bloom());
  if (FRAMES) await waitFrames(FRAMES); else await page.waitForTimeout(WAIT);
  if (DRIVE) {
    for (const key of KEYS.split(',')) await page.keyboard.down(key);
    await waitFrames(Math.round(DRIVE * 60));
    for (const key of KEYS.split(',')) await page.keyboard.up(key);
    await waitFrames(6);
  }
  if (FLIGHT) {
    await page.evaluate(() => window.tinyWorlds.bloom());
    await page.waitForTimeout(500);
    // Walk onto the beacon, then trigger the launch.
    await page.evaluate(() => {
      const tw = window.tinyWorlds;
      const p = tw.planets[tw.state.worldIndex];
      tw.player.local.copy(p.beaconDir).multiplyScalar(p.groundRadius(p.beaconDir) + 0.2);
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('KeyE');
    await waitFrames(Math.round(+(opt('flight-frames', 200))));
  }
}

if (NOHUD) await page.evaluate(() => document.body.classList.add('no-chrome'));
await page.waitForTimeout(350);

// Read inside a rAF callback: with preserveDrawingBuffer off, the canvas is
// empty once the frame has been composited.
const stats = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
  const c = document.getElementById('gl');
  const s = document.createElement('canvas');
  s.width = 240; s.height = Math.max(1, Math.round(240 * c.height / c.width));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, n = 0, sat = 0;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    lum.push(l); sum += l;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
    n++;
  }
  const mean = sum / n;
  const std = Math.sqrt(lum.reduce((a, l) => a + (l - mean) ** 2, 0) / n);
  const tw = window.tinyWorlds;
  resolve({
    meanLuma: +mean.toFixed(2), stdLuma: +std.toFixed(2), meanSat: +(sat / n).toFixed(3),
    frames: tw?.state.frames ?? 0,
    mode: tw?.state.mode,
    world: tw?.planets[tw.state.worldIndex]?.def.name,
    sparks: `${tw?.state.sparks}/${tw?.planets[tw.state.worldIndex]?.moteTotal}`,
    grounded: tw?.player.grounded,
    playerRadius: +(tw?.player.local.length() ?? 0).toFixed(2),
    fps: document.getElementById('fps')?.textContent ?? '',
  });
})));

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), timeout: 60000, animations: 'disabled' });
await browser.close();
server.close();

const report = { ok: errors.length === 0 && stats.frames > 8 && stats.stdLuma > 1.0, out: OUT, ...stats, errors: errors.slice(0, 10) };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!errors.length && stats.stdLuma <= 1.0) console.error('\nFLAT IMAGE: nothing rendered.');
  console.error(logs.slice(-30).join('\n'));
  process.exit(1);
}
