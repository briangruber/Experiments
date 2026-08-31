#!/usr/bin/env node
// Does a boat LEAVE foam on the water?
//
// The complaint is that foam rides the wake's waves rather than being deposited
// on the sea and left there. That is a claim about one thing: what the foam
// channel holds at a FIXED WORLD POINT as the boat runs away from it. If the
// foam is deposited, the point goes white as she passes and then decays slowly
// on its own. If it merely rides the pattern, it goes white and then back to
// nothing the moment the crest has gone by.
//
//   node tools/foam-persist.mjs --lat 6 --secs 40
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const LAT = +opt('lat', 6);          // metres off the track to watch
const SECS = +opt('secs', 40);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const f = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    r.end(await readFile(f));
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 400, height: 260 } });
const qs = new URLSearchParams({ prewarm: '30', 'boat.speed': '12', 'boat.turnRate': '0' });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${qs}`);
await page.waitForFunction(() => window.__wake?.wake, null, { timeout: 120000 });

const rows = await page.evaluate(({ lat, secs }) => {
  // DRIVEN, NOT WATCHED.
  //
  // The first version of this waited on the wall clock while the page rendered.
  // Under swiftshader the sim advances about a fiftieth of real time, so
  // thirty-six seconds of waiting bought 0.6 seconds of boat and the curve had
  // two points in it -- an instrument that answers confidently and measures
  // nothing, which is the failure mode this probe exists to avoid. stepSim is
  // what the prewarm uses, so drive it directly and read between steps.
  const { wake, renderer, state, stepSim, get } = window.__wake;

  // ...AND BAKE THE FIELD. stepSim advances the boat; it does not re-centre or
  // re-bake the wake texture -- the frame loop does that, right after it. So
  // the first sim-driven run read a stale texture whose centre never moved,
  // which is why it reported a flat 0.0063 for 720 m and called it 100% of
  // peak. A frozen number is not a measurement. Same two calls the frame makes.
  const bake = () => {
    const ext = get('field.extent');
    const back = wake.backAlongPath(ext * 0.56);
    const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
    const fx = back ? (state.x + back.x) * 0.5 : state.x - hx * ext * 0.28;
    const fz = back ? (state.z + back.z) * 0.5 : state.z - hz * ext * 0.28;
    wake.focus(fx, fz, ext);
    wake.update(state.t);
  };
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024); };
  // A FIXED point in the world, abeam of where she is right now. Everything
  // after this is read at that same point while she runs away from it.
  const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
  const wx = state.x + (-hz) * lat, wz = state.z + hx * lat;
  const t0 = state.t;
  const out = [];
  const read = () => {
    const rt = wake.rt, N = rt.width;
    const buf = new Uint16Array(N * N * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
    const u = (wx - wake.center.x) / wake.extent + 0.5;
    const v = -(wz - wake.center.y) / wake.extent + 0.5;
    const px = Math.round(u * (N - 1)), py = Math.round(v * (N - 1));
    if (px < 0 || py < 0 || px >= N || py >= N) return null;
    const o = (py * N + px) * 4;
    // B is the CHURN -- how disturbed this water is at all -- and it is what
    // drives the slick: the water shader multiplies it by uWakeSlick to clear
    // the sea's own wind foam, and by uWakeCalm to flatten the chop. If it is
    // small the slick is switched on and doing nothing, which is a distinction
    // no amount of reading the shader will settle.
    return { foam: h2f(buf[o]), height: h2f(buf[o + 1]),
             churn: h2f(buf[o + 2]), bub: h2f(buf[o + 3]) };
  };
  const dt = 1 / 30;
  const every = Math.round(1.5 / dt);          // a sample every 1.5 s of boat
  const steps = Math.round(secs / dt);
  for (let i = 0; i <= steps; i++) {
    if (i % every === 0) {
      // The field is baked by stepSim, so it is current for this instant.
      const s = read();
      const astern = Math.hypot(state.x - wx, state.z - wz);
      if (s) out.push([+(state.t - t0).toFixed(1), +astern.toFixed(1),
                       +s.foam.toFixed(4), +s.churn.toFixed(4)]);
      else out.push([+(state.t - t0).toFixed(1), +astern.toFixed(1), null, null]);
    }
    stepSim(dt);
    bake();
  }
  // THE LIVE UNIFORMS, not the ones the source implies.
  //
  // The first attempt at a fix moved this curve by nothing at all, and the
  // choice then is between guessing which term is still zeroing it and asking.
  // Every arc-based cut that can reach the foam is printed here so the curve is
  // read next to the numbers that shaped it.
  const u = wake.uniforms;
  const uni = {};
  for (const k of ['uArmPersist', 'uFadeStart', 'uFadeLen', 'uFoamLife',
                   'uDissolve', 'uMaxArc', 'uBreakup', 'uArmFoam', 'uMelt'])
    if (u[k]) uni[k] = u[k].value;
  return { out, uni, persistParam: get('arms.persist'), maxArc: wake.maxArc };
}, { lat: LAT, secs: SECS });
const { out: rowsOut, uni, persistParam, maxArc } = rows;
await browser.close(); server.close();

console.log(`Foam at ONE fixed world point ${LAT} m off the track, as she runs away.\n`);
console.log('  t(s)  astern(m)     foam     churn');
let peak = 0;
for (const [t, a, f, b] of rowsOut) {
  if (f === null) { console.log(String(t).padStart(6), String(a).padStart(10), '   (outside the field)'); continue; }
  peak = Math.max(peak, f);
  const bar = '#'.repeat(Math.round(Math.min(f, 2) * 30));
  console.log(String(t).padStart(6), String(a).padStart(10), String(f).padStart(8), String(b).padStart(9), ' ' + bar);
}
const live = rowsOut.filter((r) => r[2] !== null);
const last = live[live.length - 1];
console.log('\nlive uniforms:', JSON.stringify(uni));
console.log('arms.persist param:', persistParam, '  ribbon maxArc:', maxArc);
console.log(`\npeak ${peak.toFixed(3)}`);
if (last) console.log(`after ${last[0]} s and ${last[1]} m astern: foam ${last[2]} `
  + `(${peak > 0 ? (100 * last[2] / peak).toFixed(0) : 0}% of peak)`);
