#!/usr/bin/env node
// Does the wave runner ride the way it is supposed to?
//
//   node tools/check-ride.mjs            # dist/abyssal-three.html, WebGL2 backend
//
// Everything below drives the BUILT three.js bundle through the keyboard and
// then reads state, because every regression this file exists to catch was
// invisible in a screenshot and silent in the console.
//
// ---------------------------------------------------------------------------
// WHAT IT ASSERTS, AND WHY EACH ONE IS PHRASED THE WAY IT IS
//
// 1. THE CAMERA IS ON ITS RIG. Not "somewhere plausible behind the craft" -
//    ON the rig, to the centimetre, compared against rider.camRig, the point
//    the rider itself computed this frame. The distance-from-craft version of
//    this test passes while the bug is present: with demo/camera.js left
//    unlocked, the flying controls read the same W/A/D/Shift the rider does and
//    shove the camera several metres off the rig every frame, and it still
//    trails the craft. Measured with the fault reintroduced: 1.7 m off the rig
//    holding W and D, 10.2 m the moment Shift joins them - Shift multiplies the
//    fly speed by six. Reported as "shaking kind of violently".
//
// 2. IT IS SAMPLED FROM cam3, NOT camera. rider.update() ends by writing the
//    rig into the camera, so any check that reads `camera` after the frame sees
//    a perfect ride no matter what the frame was actually drawn through. cam3
//    is the three camera the passes were rasterised with.
//
// 3. SHIFT BUYS A HARDER TURN. wrCarveTurn is 1.9, so the same corner taken
//    with the bar buried has to show a clearly higher steady yaw rate.
//
// 4. THE BOW LEADS. Read off the model matrix BASIS COLUMNS, never a quaternion
//    - demo/craft.js applies the model's yaw correction inside the craft frame,
//    which for the default PI leaves a mirrored basis, and decomposing that into
//    a quaternion is meaningless. Asserting "one horizontal axis lies along
//    travel and the other across it" also avoids baking in a claim about which
//    way the source asset faces, which is what let an earlier version of this
//    check pass while the craft drove backwards.
//
// 5. THE SPRAY EMITTER HAS A CRAFT. src/gpu/tsl/spray.js reads the rig by
//    numeric index; handing it three vectors made every uniform NaN, and a NaN
//    emitter emits nothing and reports nothing.
//
// Airborne fraction is REPORTED, never asserted. A software rasteriser runs
// this at a couple of frames a second against a rider that clamps dt to 1/20 s,
// and that alone makes any hull skip: measured side by side under this harness
// it came out 0.41 on the raw-GL demo and 0.63 here, peak altitude under 1.3 m
// in both. A threshold on it would be testing the rasteriser.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PAGE = opt('page', 'dist/abyssal-three.html');
const BACKEND = opt('backend', 'webgl');
const LEG = +opt('leg', 9000);   // ms per leg; the default suits SwiftShader

const server = createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(ROOT, PAGE)));
  } catch (e) { res.writeHead(404).end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${server.address().port}/?backend=${BACKEND}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });
// The load shed a software rasteriser needs to reach a usable frame rate.
await page.evaluate(() => { window.abyssal.params.renderScale = 0.25; window.abyssal.params.cloudSteps = 6; });

// Sample from inside the frame callback so every frame is seen. Polling from
// outside at a couple of frames a second would miss the excursions, and the
// excursions are the entire question.
await page.evaluate(() => {
  const A = window.abyssal;
  A.__log = [];
  const norm = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  A.onFrame = () => {
    const r = A.rider, c = A.cam3;
    if (!r.active) return;
    // Heading alignment EVERY FRAME, not once at the end. `heading` accumulates
    // without wrapping, so where it happens to land after a long turn is
    // arbitrary - and a single sample can land on an axis, where sin or cos is
    // zero and a sign error in the yaw is invisible. Sampled continuously, the
    // craft sweeps every quadrant and the worst frame is the verdict.
    const e = A.craftMesh.matrix.elements;
    const want = [Math.sin(r.heading), -Math.cos(r.heading)];
    const nz = norm([e[8], e[10]]), nx = norm([e[0], e[2]]);
    A.__log.push({
      alignZ: nz[0] * want[0] + nz[1] * want[1],
      alignX: nx[0] * want[0] + nx[1] * want[1],
      offAxis: Math.min(Math.abs(want[0]), Math.abs(want[1])),
      d: Math.hypot(c.position.x - r.pos[0], c.position.z - r.pos[2]),
      dy: c.position.y - (r.deckY ?? 0),
      rigErr: r.camRig
        ? Math.hypot(c.position.x - r.camRig[0], c.position.y - r.camRig[1], c.position.z - r.camRig[2])
        : 0,
      yaw: Math.abs(r.yawRate),
      sp: Math.abs(r.speed),
      air: r.airborne ? 1 : 0,
    });
  };
});

const keys = (add) => page.evaluate((a) => {
  for (const k of a) window.abyssal.camera.keys.add(k);
  window.abyssal.__log.length = 0;
}, add);
const take = () => page.evaluate(() => window.abyssal.__log.slice());
const wait = (ms) => page.waitForTimeout(ms);

await page.evaluate(() => window.abyssal.toggleRide());
await keys(['KeyW']);                 // on the plane
await wait(LEG);
await keys(['KeyD']);                 // a steady corner
await wait(LEG);
const plain = await take();
await keys(['ShiftLeft']);            // the same corner, carved
await wait(LEG);
const carve = await take();

const head = await page.evaluate(() => {
  const A = window.abyssal;
  return {
    ctxSpeed: A.ctx.craftSpeed || 0,
    ctxAmount: A.ctx.craftAmount || 0,
    ctxFinite: [...A.ctx.craftPos].every(Number.isFinite),
    hullPush: A.hull.push, hullPlane: A.hull.plane,
  };
});

// Second half of each leg only: pressing a key starts a ramp, and the steady
// state is what is being compared.
const settled = (rows) => rows.slice(Math.floor(rows.length / 2));
const stat = (rows, f) => {
  const v = settled(rows).map(f).filter(Number.isFinite);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
  return { n: v.length, mean, max: Math.max(...v), min: Math.min(...v) };
};
const jitter = (rows0) => {
  const rows = settled(rows0);
  let m = 0;
  for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.abs(rows[i].d - rows[i - 1].d));
  return m;
};
const leg = (rows) => ({
  d: stat(rows, (r) => r.d), dy: stat(rows, (r) => r.dy),
  rigErr: stat(rows, (r) => r.rigErr), yaw: stat(rows, (r) => r.yaw),
  speed: stat(rows, (r) => r.sp), airFrac: stat(rows, (r) => r.air).mean,
  jitter: jitter(rows),
  alignZ: stat(rows, (r) => r.alignZ), alignX: stat(rows, (r) => r.alignX),
  offAxis: stat(rows, (r) => r.offAxis),
});

const D = await page.evaluate(() => window.abyssal.params.wrCamDistance);
const out = { plain: leg(plain), carve: leg(carve), heading: head, camDistance: D, carveGain: 0 };
out.carveGain = out.carve.yaw.mean / Math.max(out.plain.yaw.mean, 1e-3);
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1));

const fails = [];
const need = (cond, msg) => { if (!cond) fails.push(msg); };
need(plain.length > 4 && carve.length > 4, 'not enough frames sampled');
need(out.plain.rigErr.max < 0.05, `camera ${out.plain.rigErr.max.toFixed(2)} m off its rig under throttle+steer`);
need(out.carve.rigErr.max < 0.05, `camera ${out.carve.rigErr.max.toFixed(2)} m off its rig under carve`);
need(out.plain.jitter < D * 0.6 && out.carve.jitter < D * 0.6, 'camera-to-craft distance jitters');
need(out.carve.dy.min > -2, 'chase camera dipped below the deck');
need(out.carveGain > 1.3, `Shift bought only ${out.carveGain.toFixed(2)}x the yaw rate`);
// Over the whole carve leg the craft sweeps its heading round, so at least one
// sampled frame must sit well off both axes - otherwise a yaw sign error could
// be hiding in a sin or cos of zero and the alignment below proves nothing.
need(out.carve.offAxis.max > 0.3, 'craft never turned off-axis, so heading proves nothing');
need(out.carve.alignZ.min > 0.99, `bow not along travel (worst ${out.carve.alignZ.min.toFixed(3)})`);
need(Math.abs(out.carve.alignX.max) < 0.15 && Math.abs(out.carve.alignX.min) < 0.15,
  `beam not across travel (${out.carve.alignX.min.toFixed(3)}..${out.carve.alignX.max.toFixed(3)})`);
need(head.ctxSpeed > 1 && head.ctxAmount > 0 && head.ctxFinite, 'spray emitter has no live craft');
need(head.hullPush > 0 && head.hullPlane > 0, 'hull is not displacing water');
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'RIDE FAILED\n  ' + fails.join('\n  ') : 'RIDE OK');
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
