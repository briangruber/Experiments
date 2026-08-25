#!/usr/bin/env node
// Does the lace actually move, and does it stay put while it does?
//
// Two failure modes, opposite to each other: no animation at all, or animation
// that translates — foam sliding across water it is supposed to be floating on.
// So this measures both, with the boat stopped and foam life pinned long so
// decay cannot be mistaken for motion.
//
// Sim time is advanced explicitly rather than by waiting: dt is clamped per
// frame, so on a headless renderer at ~2 fps a two-second wait buys only a
// fraction of a second of animation, and a working lace reads as a dead one.
//
// The swell must be flattened for either measurement to mean anything: moving
// water changes shading under perfectly static foam, and that baseline is large
// enough to swamp the signal being looked for.
//
//   node tools/motion.mjs            # churn + boil animate the lace in place
//   node tools/motion.mjs --still    # control: motion params zeroed
//   node tools/motion.mjs --drift    # the swell-surge term is live

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const STILL = argv.includes('--still');
const DRIFT = argv.includes('--drift');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const qs = new URLSearchParams({ prewarm: '90', cam: opt('cam', '-1.5708,0,90') });
qs.set('foamLook.life', '120');      // decay must not masquerade as motion
qs.set('foamLook.dissolve', '0.2');
// Flat, still water: with the swell running, shading changes under static foam
// and drowns out what is being measured.
if (!DRIFT) { qs.set('ocean.swellAmp', '0'); qs.set('ocean.chopAmp', '0'); }
if (STILL) for (const k of ['drift','ringAmount','ringRelief','boil','plumeSwirl']) qs.set('foamMotion.' + k, '0');

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 620, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${server.address().port}/?${qs}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
// Stop the boat: with it moving, everything shifts and nothing can be told apart.
await page.evaluate(() => window.__wake.set('boat.speed', 0));
await page.waitForTimeout(2500);
await page.evaluate(() => document.body.classList.add('hide-ui'));

const grab = async () => (await page.screenshot()).toString('base64');
// Advance the simulation by a known amount of ITS time, then let a frame land.
const advance = async (sec) => {
  await page.evaluate((d) => { window.__wake.state.t += d; }, sec);
  await page.waitForTimeout(900);
};
let a, b;
if (DRIFT) {
  // Compare the same instant at two drift settings, so time is not a variable
  // and only the swell-surge term can account for a difference.
  await page.evaluate(() => { window.__wake.set('foamMotion.drift', 0);
                              window.__wake.set('foamMotion.ringAmount', 0);
                              window.__wake.set('foamMotion.ringRelief', 0);
                              window.__wake.set('foamMotion.boil', 0); });
  await page.waitForTimeout(900);
  a = await grab();
  await page.evaluate(() => window.__wake.set('foamMotion.drift', 2.5));
  await page.waitForTimeout(120);
  b = await grab();
} else {
  a = await grab();
  await advance(2.6);
  b = await grab();
}

if (argv.includes('--save')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(ROOT, 'shots/motion-a.png'), Buffer.from(a, 'base64'));
  await writeFile(resolve(ROOT, 'shots/motion-b.png'), Buffer.from(b, 'base64'));
}
const probe = await browser.newPage();
const stats = await probe.evaluate(async ([A, B]) => {
  const load = async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 200, 200);
    return g.getImageData(0, 0, 200, 200).data;
  };
  const [da, db] = [await load(A), await load(B)];
  const lum = (d, i) => (d[i] + d[i+1] + d[i+2]) / 3;

  let changed = 0, foamN = 0, sumDiff = 0;
  let cxA = 0, cyA = 0, wA = 0, cxB = 0, cyB = 0, wB = 0;
  for (let i = 0, p = 0; i < da.length; i += 4, p++) {
    const x = p % 200, y = (p / 200) | 0;
    const la = lum(da, i), lb = lum(db, i);
    if (la > 110) { foamN++; cxA += x * la; cyA += y * la; wA += la; }
    if (lb > 110) { cxB += x * lb; cyB += y * lb; wB += lb; }
    const d = Math.abs(la - lb);
    sumDiff += d;
    if (d > 14) changed++;
  }
  const n = da.length / 4;
  return {
    foamPixels: foamN,
    changedFraction: +(changed / n).toFixed(4),
    meanAbsDiff: +(sumDiff / n).toFixed(2),
    centroidShiftPx: +Math.hypot(cxA / wA - cxB / wB, cyA / wA - cyB / wB).toFixed(2),
  };
}, [a, b]);
await probe.close();

const mode = DRIFT ? 'drift term' : STILL ? 'still (control)' : 'rings + boil';
console.log(JSON.stringify({ mode, stats, errors }, null, 2));
await browser.close(); server.close();

if (errors.length) process.exit(1);
if (DRIFT) {
  if (stats.changedFraction < 0.010) { console.error('FAIL: drift term has no effect'); process.exit(1); }
} else if (STILL) {
  if (stats.changedFraction > 0.004) { console.error('FAIL: lace moves with motion params at zero'); process.exit(1); }
} else {
  if (stats.changedFraction < 0.020) { console.error('FAIL: lace is not animating'); process.exit(1); }
  if (stats.centroidShiftPx > 2.5) { console.error('FAIL: foam is drifting, not distorting in place'); process.exit(1); }
}
