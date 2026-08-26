#!/usr/bin/env node
// Load the bundled single file exactly as the artifact host will: as body
// content inside a bare document, from a directory containing nothing else.
// If the module graph is broken, this catches it here instead of after publish.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SRC = resolve(ROOT, opt('in', 'dist/wake-lab.html'));
const OUT = resolve(ROOT, opt('out', 'shots/artifact.png'));

const body = await readFile(SRC, 'utf8');
const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => server.listen(0, r));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// deviceScaleFactor 2 on purpose: pixel-ratio bugs are invisible at 1.
const DPR = +(opt('dpr', '2'));
// Small viewport, but deviceScaleFactor still 2: the point of the DPR is to
// catch pixel-ratio bugs (a whole session was lost to one), and that needs the
// ratio, not the resolution. 1280x800 at DPR 2 is a 2560x1600 buffer, and
// SwiftShader now has an FFT ocean, a sky LUT, a cloud march and 147k terrain
// vertices to fill -- which timed out the screenshot at 180 s and reported it
// as a failure of the bundle rather than of the rig. 640x400 is the same test
// at a quarter of the fill.
const p = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: DPR });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await p.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
const ready = await p.waitForFunction('window.__ready === true', { timeout: 150000 })
  .then(() => true).catch(() => false);
await p.waitForTimeout(2500);

const diag = await p.evaluate(() => ({
  dpr: window.devicePixelRatio,
  canvas: (() => { const c = document.getElementById('gl');
    return { buf: [c.width, c.height], css: [c.clientWidth, c.clientHeight] }; })(),
  ready: !!window.__ready,
  travelled: Math.round(Math.hypot(window.__wake?.state.x ?? 0, window.__wake?.state.z ?? 0)),
  maxArc: Math.round(window.__wake?.wake.maxArc ?? 0),
  fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  rail: !!document.querySelector('#ui details'),
}));

await mkdir(dirname(OUT), { recursive: true });
await p.screenshot({ path: OUT, timeout: 300000 });

// Measure the screenshot, not the live canvas: reading back from a WebGL
// canvas needs preserveDrawingBuffer and silently returns zeros without it.
// A black rectangle is the failure mode here, and every other check above
// still passes when it happens.
const shot = await p.screenshot({ clip: { x: 0, y: 0, width: 560, height: 400 }, timeout: 300000 });
const probe = await browser.newPage();
const ink = await probe.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 160; c.height = 136;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  // Foam is measured against the water it sits on, not against an absolute
  // brightness: the scene is a sunset lake now, and real foam there peaks
  // around luma 120 where the old daylight grey put it past 180. What makes
  // a wake visible is contrast with the surrounding water, so take the
  // median as "water" and count what stands clear of it.
  const lum = new Float64Array(d.length / 4);
  let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    lum[j] = v;
    sum += v;
  }
  const n = lum.length;
  const water = Float64Array.from(lum).sort()[n >> 1];
  let lit = 0;
  for (let j = 0; j < n; j++) if (lum[j] > water + 22) lit++;
  return { meanLuma: +(sum / n).toFixed(1), water: +water.toFixed(1),
           foamFraction: +(lit / n).toFixed(4) };
}, shot.toString('base64'));
await probe.close();
await browser.close();
server.close();

console.log(JSON.stringify({ ready, diag, ink, errors }, null, 2));

const fatal = errors.filter((e) => !/fonts\.googleapis|fonts\.gstatic|ERR_CONNECTION_RESET/.test(e));
if (!ready || fatal.length) process.exit(1);
if (ink.meanLuma < 12) { console.error('FAIL: canvas is essentially black'); process.exit(1); }
if (ink.foamFraction < 0.01) { console.error('FAIL: no wake visible above the water'); process.exit(1); }
