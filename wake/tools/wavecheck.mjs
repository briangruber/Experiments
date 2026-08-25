#!/usr/bin/env node
// Do the waves actually move through the water, or is the pattern painted on?
//
// Watch ONE fixed point in world space while the boat runs past at constant
// speed, and record the surface height there. If crests genuinely propagate,
// that point rises and falls with period lambda / V. A pattern merely painted
// into the texture would sit still and the height would barely change.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try { const u = decodeURIComponent(q.url.split('?')[0]);
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    r.end(await readFile(p)); } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 420, height: 420 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const extra = process.argv.slice(2).filter((a) => a.includes('=')).join('&');
// The prediction lambda/V is for the TRANSVERSE system on the centreline, so
// --set kelvin.divergent=0 isolates the case the number actually describes.
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=20&arms.foam=0&wash.foam=0&bubbles.plume=0${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1000);

// The field is re-baked inside the render loop, so the sim must be stepped
// from out here with real frames in between -- stepping it all inside one
// evaluate() reads the same stale texture every time.
const setup = await page.evaluate(() => {
  const w = window.__wake;
  const hx = Math.sin(w.state.heading), hz = Math.cos(w.state.heading);
  window.__probePoint = { x: w.state.x - hx * 26, z: w.state.z - hz * 26 };
  const V = w.get('boat.speed');
  const lambda = 6.28318 / (9.81 / (V * V) / w.get('kelvin.waveScale'));
  return { V, lambda: +lambda.toFixed(1), expectedPeriod: +(lambda / V).toFixed(2) };
});

const readHeight = () => page.evaluate(() => {
  const w = window.__wake, rt = w.wake.rt, N = rt.width;
  const buf = new Uint16Array(4);
  const p = window.__probePoint;
  const u = (p.x - w.wake.center.x) / w.wake.extent + 0.5;
  const v = -(p.z - w.wake.center.y) / w.wake.extent + 0.5;
  const ix = Math.round(u * (N - 1)), iy = Math.round(v * (N - 1));
  if (ix < 0 || iy < 0 || ix >= N || iy >= N) return null;
  w.renderer.readRenderTargetPixels(rt, ix, iy, 1, 1, buf);
  const h = buf[1];
  const sgn = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  const val = e === 0 ? sgn * Math.pow(2, -14) * (m / 1024)
            : e === 31 ? NaN : sgn * Math.pow(2, e - 15) * (1 + m / 1024);
  return +val.toFixed(4);
});

const DT = 0.18, N_SAMPLES = 34;
const series = [];
for (let i = 0; i < N_SAMPLES; i++) {
  await page.evaluate((d) => { const w = window.__wake;
    for (let k = 0; k < Math.round(d / 0.02); k++) w.stepSim(0.02); }, DT);
  await page.waitForTimeout(320);              // let a frame re-bake the field
  const h = await readHeight();
  if (h === null) break;
  series.push(h);
}
const out = { ...setup, dt: DT, series };

await browser.close(); server.close();

// Count zero crossings of the (mean-removed) series to get the period.
const s = out.series;
const mean = s.reduce((a, b) => a + b, 0) / s.length;
const c = s.map((v) => v - mean);
let crossings = 0;
for (let i = 1; i < c.length; i++) if (c[i - 1] <= 0 && c[i] > 0) crossings++;
const span = (c.length - 1) * out.dt;
const measured = crossings > 1 ? span / crossings : NaN;
const amp = Math.max(...s) - Math.min(...s);

console.log(JSON.stringify({
  boatSpeed: out.V, wavelength_m: out.lambda,
  expectedPeriod_s: out.expectedPeriod,
  measuredPeriod_s: +measured.toFixed(2),
  peakToPeak_m: +amp.toFixed(3),
  samples: s.length,
}, null, 2));
if (errs.length) { console.error(errs); process.exit(1); }
