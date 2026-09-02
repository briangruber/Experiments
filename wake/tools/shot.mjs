#!/usr/bin/env node
// Headless capture. Serves the folder, loads the page, lets the wake build for
// a while, screenshots, and fails loudly on any console/page error so it works
// as a smoke test too.
//
//   node tools/shot.mjs --out shots/a.png --wait 12 --set arms.angle=18
//   node tools/shot.mjs --out shots/turn.png --set boat.turnRate=6 --cam -1.1,0.4,70

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
// Every value after --set up to the next --flag, so `--set a=1 b=2` sets both.
// (It used to take only the first, which silently dropped the rest.)
const multi = (n) => { const out = []; for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--' + n) continue;
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]); }
  return out; };

const OUT = resolve(ROOT, opt('out', 'shots/frame.png'));
const WAIT = +opt('wait', 3);           // seconds to let the page settle before the shot
const W = +opt('w', 1100), H = +opt('h', 1100);
const CAM = opt('cam', '');
const PREWARM = opt('prewarm', '90');   // seconds of boat run before the first frame

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                   '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const qs = new URLSearchParams();
for (const s of multi('set')) { const [k, v] = s.split('='); qs.set(k, v); }
if (CAM) qs.set('cam', CAM);
qs.set('prewarm', PREWARM);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '?' + qs.toString(), { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(WAIT * 1000);
if (argv.includes('--field')) await page.keyboard.press('f');
// Guarded: when the module fails to load there is no __wake, and the useful
// output is the error that caused it -- not a crash inside the probe.
const diag = await page.evaluate(() => {
  const w = window.__wake;
  if (!w) return { loaded: false };
  const b = w.wakeBridge;
  // Read the field back. This is the one measurement that splits the two
  // candidate faults apart: an empty texture means the bake is wrong, a full
  // one means the shading chain is dropping it. Guessing between them from a
  // picture costs a render each time.
  let field = null;
  try {
    const rt = w.wake.rt, r = w.renderer;
    const N = 64;
    // Uint16Array, NOT Float32Array. The target is HalfFloatType, and reading
    // it into a float buffer is a type mismatch that yields ZEROS without
    // throwing -- so the first version of this probe reported an empty field
    // and sent me looking at the bake. The control (same readback with the
    // analytic ocean, where the wake is plainly on screen) also read zero,
    // which is what proved the instrument wrong rather than the field.
    const raw = new Uint16Array(N * N * 4);
    const half = (h) => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const buf = { length: raw.length, get: (i) => half(raw[i]) };
    r.readRenderTargetPixels(rt, (rt.width - N) >> 1, (rt.height - N) >> 1, N, N, raw);
    let maxR = 0, maxAbsG = 0, nonZero = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const rr = buf.get(i), gg = buf.get(i + 1);
      maxR = Math.max(maxR, rr);
      maxAbsG = Math.max(maxAbsG, Math.abs(gg));
      if (rr > 0.002) nonZero++;
    }
    field = { maxFoam: +maxR.toFixed(4), maxHeight: +maxAbsG.toFixed(4),
              litTexels: nonZero, of: N * N };
  } catch (e) { field = { error: String(e).slice(0, 80) }; }
  return { pathPts: w.wake.path.length, maxArc: +(w.wake.maxArc || 0).toFixed(1),
           travelled: +Math.hypot(w.state.x, w.state.z).toFixed(1),
           extent: w.wake.extent, drawn: w.wake.geometry.drawRange.count,
           abyssal: !!w.sea && w.get('scene.abyssal') > 0.5,
           bridge: b ? { on: b.lastOn, hasTex: b.lastHasTex, frames: b.frames,
                         extent: +(b.lastExtent || 0).toFixed(1) } : null,
           sprayLive: w.spray ? w.spray.n : null, field };
});
await page.evaluate(() => document.body.classList.add('hide-ui'));
await page.waitForTimeout(300);

await mkdir(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, timeout: 240000 });
await browser.close();
server.close();

console.log(JSON.stringify({ out: OUT, diag, errors }, null, 2));
if (errors.length) process.exit(1);
