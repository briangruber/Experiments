#!/usr/bin/env node
// Bring the boat to a dead stop, then watch the water it already disturbed.
//
// Waves already made have their own momentum: they must keep travelling after
// the boat has stopped. If the pattern is tied to the hull it freezes instead,
// and that shows up here as no change between two frames of a stopped boat.
//
//   node tools/coast.mjs            # waves run free
//   node tools/coast.mjs --locked   # control: pattern pinned to the boat
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKED = process.argv.includes('--locked');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try { const u = decodeURIComponent(q.url.split('?')[0]);
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    r.end(await readFile(p)); } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const qs = new URLSearchParams({ prewarm: '40', cam: '-1.5708,0,150' });
// Isolate the waves: no foam, no bubbles, no lace animation, flat sea.
for (const [k, v] of Object.entries({
  'arms.foam': 0, 'wash.foam': 0, 'wash.tailFoam': 0,
  'bubbles.plume': 0, 'bubbles.fromArms': 0,
  'ocean.swellAmp': 0, 'ocean.chopAmp': 0,
  'foamMotion.ringAmount': 0, 'foamMotion.boil': 0, 'foamMotion.drift': 0,
  'kelvin.propagate': LOCKED ? 0 : 1,
})) qs.set(k, String(v));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 560, height: 560 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/?${qs}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 90000 }).catch(() => {});
await page.evaluate(() => document.body.classList.add('hide-ui'));
await page.waitForTimeout(1200);

// Full stop, then let the water alone.
await page.evaluate(() => {
  const w = window.__wake;
  w.set('boat.speed', 0);
  w.set('boat.accel', 12);
  for (let i = 0; i < 120; i++) w.stepSim(0.033);   // decelerate to rest
});
await page.waitForTimeout(800);

const grab = async () => (await page.screenshot({ timeout: 180000 })).toString('base64');
const a = await grab();
const moved = await page.evaluate(() => {
  const w = window.__wake;
  const before = { x: w.state.x, z: w.state.z };
  for (let i = 0; i < 90; i++) w.stepSim(0.033);    // 3 s with the boat at rest
  return { speed: +w.state.speed.toFixed(3),
           drift: +Math.hypot(w.state.x - before.x, w.state.z - before.z).toFixed(3) };
});
await page.waitForTimeout(800);
const b = await grab();

const probe = await browser.newPage();
const diff = await probe.evaluate(async ([A, B]) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0, 200, 200);
    return g.getImageData(0, 0, 200, 200).data; };
  const [da, db] = [await load(A), await load(B)];
  let changed = 0, sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs((da[i]+da[i+1]+da[i+2])/3 - (db[i]+db[i+1]+db[i+2])/3);
    sum += d; if (d > 6) changed++;
  }
  return { changedFraction: +(changed / (da.length/4)).toFixed(4), meanAbsDiff: +(sum/(da.length/4)).toFixed(2) };
}, [a, b]);
await probe.close();

console.log(JSON.stringify({ mode: LOCKED ? 'locked to boat (control)' : 'waves run free', boat: moved, diff, errs }, null, 2));
await browser.close(); server.close();
if (errs.length) process.exit(1);
if (!LOCKED && diff.changedFraction < 0.02) { console.error('FAIL: waves freeze when the boat stops'); process.exit(1); }
