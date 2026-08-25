#!/usr/bin/env node
// Read the wake field directly and print a lateral slice across it, so
// structure that saturates to white on screen can still be counted.
//
//   node tools/probe.mjs --arc 6 --engines 3
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ARC = +opt('arc', 6);

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    if (!p.startsWith(ROOT)) return void r.writeHead(403).end();
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    r.end(await readFile(p));
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const qs = new URLSearchParams({ prewarm: '60' });
for (const s of argv.reduce((a, v, i) => (v === '--set' ? [...a, argv[i+1]] : a), []))
  qs.set(s.split('=')[0], s.split('=')[1]);
if (opt('engines', null)) qs.set('boat.engines', opt('engines'));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 500, height: 500 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/?${qs}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate((arc) => {
  const { wake, renderer, state } = window.__wake;
  const rt = wake.rt, N = rt.width;
  const buf = new Uint16Array(N * N * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
  // half -> float
  const h2f = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  };
  // World point `arc` metres astern of the bow, swept laterally.
  const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
  const nx = -hz, nz = hx;
  const row = [];
  for (let i = -60; i <= 60; i++) {
    const lat = i * 0.12;
    const wx = state.x - hx * arc + nx * lat;
    const wz = state.z - hz * arc + nz * lat;
    const u = (wx - wake.center.x) / wake.extent + 0.5;
    const v = -(wz - wake.center.y) / wake.extent + 0.5;
    const px = Math.round(u * (N - 1)), py = Math.round(v * (N - 1));
    if (px < 0 || py < 0 || px >= N || py >= N) { row.push([lat, 0, 0]); continue; }
    const o = (py * N + px) * 4;
    row.push([+lat.toFixed(2), +h2f(buf[o]).toFixed(3), +h2f(buf[o + 3]).toFixed(3)]);
  }
  return row;
}, ARC);
await browser.close(); server.close();

// Count lobes in the subsurface channel, which does not saturate the way foam
// does. Peaks are found by prominence rather than by strict local maxima:
// bilinear sampling flattens their tops, and a naive local-max test then finds
// none at all -- including for a single engine, which is how it announces that
// the test is wrong rather than the shader.
const half = +opt('span', 4.2);
const slice = out.filter((r) => Math.abs(r[0]) <= half);
const vals = slice.map((r) => r[2]);
const peak = Math.max(...vals);
const MIN_PROM = 0.18;                      // fraction of peak a dip must reach

let lobes = 0, i = 0;
while (i < vals.length) {
  if (vals[i] < peak * 0.4) { i++; continue; }
  let j = i;
  while (j + 1 < vals.length && vals[j + 1] >= vals[j] * 0.999) j++;   // climb (plateaus ok)
  const top = vals[j];
  let k = j;
  while (k + 1 < vals.length && vals[k + 1] <= vals[k] * 1.001) k++;   // descend
  const dip = Math.min(...vals.slice(j, k + 1));
  if (top >= peak * 0.4 && (top - dip) >= peak * MIN_PROM || k >= vals.length - 1) lobes++;
  i = k + 1;
}

const want = +opt('expect', 0);
console.log(`arc = ${ARC} m   peak = ${peak.toFixed(3)}   lobes = ${lobes}` + (want ? `   expected ${want}` : ''));
console.log('lat      foam   bubbles');
for (const r of out.filter((_, i) => i % 4 === 0)) {
  const bar = '#'.repeat(Math.round(r[2] / Math.max(peak, 1e-6) * 40));
  console.log(String(r[0]).padStart(6), String(r[1]).padStart(7), String(r[2]).padStart(7), bar);
}
if (errs.length) { console.error(errs); process.exit(1); }
if (want && lobes !== want) { console.error(`FAIL: ${lobes} wash channels, expected ${want}`); process.exit(1); }
