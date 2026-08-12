#!/usr/bin/env node
// Headless capture and smoke test.
//
//   node tools/shot.mjs --out shots/frame.png --wait 6000 --w 1280 --h 720
//   node tools/shot.mjs --out shots/phone.png --w 390 --h 844 --touch
//
// Boots the game in Chromium, plays it for a few seconds by driving the same
// input object the player uses, and writes a PNG. Exits non-zero on any page
// error or console error, so it doubles as the regression test.

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
const WAIT = +opt('wait', 6000);
const W = +opt('w', 1280);
const H = +opt('h', 720);
const TOUCH = has('touch');
const KEEP = has('title');            // capture the menu instead of playing
const FREEZE = opt('freeze', '');     // "x,y,z,tx,ty,tz" — scenic still instead of chase cam

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
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  hasTouch: TOUCH,
  isMobile: TOUCH,
});

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  logs.push(`${m.type()}: ${t}`);
  if (m.type() === 'error') errors.push(`console: ${t}`);
});
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

// Wait for boot, then play.
await page.waitForFunction(() => window.__skyline || !document.getElementById('fail').hidden, null, { timeout: 60000 });

const report = await page.evaluate(async ({ wait, keep, freeze }) => {
  const s = window.__skyline;
  if (!s) return { fatal: document.getElementById('fail-msg').textContent };
  if (keep) return { backend: s.backend, skipped: true };

  s.start();
  const input = s.input;
  input.enabled = true;

  const t0 = performance.now();
  let frames = 0;
  const count = () => { frames++; requestAnimationFrame(count); };
  requestAnimationFrame(count);

  // Scenic still: stop the loop and let any in-flight frame land before taking
  // the camera over, or that frame renders the chase view on top of ours.
  if (freeze) {
    s.stop();
    await new Promise((r) => setTimeout(r, 6000));
    const [x, y, z, tx, ty, tz] = freeze.split(',').map(Number);
    s.camera.position.set(x, y, z);
    s.camera.up.set(0, 1, 0);
    s.camera.lookAt(tx, ty, tz);
    s.camera.updateMatrixWorld(true);
    await s.draw();
    return { backend: s.backend, frozen: true, buildings: s.city.count, avatar: !!s.avatar?.ready };
  }

  // Swing: hold a web, alternate hands, dive between arcs.
  const step = async (ms, fn) => {
    fn();
    await new Promise((r) => setTimeout(r, ms));
  };
  const cycles = Math.max(1, Math.floor(wait / 1600));
  for (let i = 0; i < cycles; i++) {
    const side = i % 2 ? 'webRight' : 'webLeft';
    await step(950, () => { input[side] = true; input.reel = i % 3 === 0; });
    await step(420, () => { input[side] = false; input.reel = false; input.dive = true; });
    await step(230, () => { input.dive = false; });
  }
  await step(500, () => { input.webLeft = true; });

  const p = s.player;
  return {
    backend: s.backend,
    fps: Math.round(frames / ((performance.now() - t0) / 1000)),
    speed: +(p.speed * 3.6).toFixed(1),
    altitude: +p.pos.y.toFixed(1),
    attached: p.web.active,
    score: s.rings.score,
    collected: s.rings.collected,
    avatar: !!s.avatar?.ready,
    buildings: s.city.count,
    drawCalls: s.renderer.info?.render?.drawCalls ?? null,
  };
}, { wait: WAIT, keep: KEEP, freeze: FREEZE });

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
// Software rasterisation can take seconds per frame; the default 30 s cap is
// not enough to catch a settled one.
await page.screenshot({ path: join(ROOT, OUT), type: 'png', timeout: 180000, animations: 'disabled' });

await browser.close();
server.close();

console.log(JSON.stringify({ out: OUT, ...report, errors }, null, 2));
if (report.fatal || errors.length) process.exit(1);
