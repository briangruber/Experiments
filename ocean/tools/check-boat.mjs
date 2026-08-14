#!/usr/bin/env node
// Does the fishing boat float, drive, and stay a displacement hull doing it?
//
//   node tools/check-boat.mjs            # dist/abyssal-three.html, WebGL2 backend
//
// This is check-ride.mjs's structure reused, not re-derived - the boat IS a
// second WaveRunner instance (three-main.js's remapParams()), so the same
// sampling and the same claims about the camera rig and the up-vector apply
// unchanged. What differs is boat-specific and asserted here on purpose:
//
// 1. THE BOW LEADS, SAME SIGN AS THE SKI NOW. boatYawOffset was 0.0 - "no
//    correction needed, verified against the source mesh" - and that
//    verification was wrong: reported live, the boat drove stern-first. An
//    orthographic top-down render with markers at the exact hull tips (no
//    perspective or up-vector to misread) showed the actual pointed bow at
//    +Z and the flat, winch-equipped stern at -Z, the reverse of the
//    original read. boatYawOffset is now pi (presets.js), the same fix the
//    ski's craftYawOffset already made for its own reversed source
//    convention, which is why the alignment here is now the RAW z column,
//    not negated - matching check-ride.mjs's own convention instead of
//    diverging from it. Got the sign backwards once already going the OTHER
//    way in prototypes/boat-drive-probe.html, when boatYawOffset was still
//    0: alignZ came back -1.000 dead-on there, +1.000 after negating it. With
//    the yaw offset now corrected instead, negating again would just be
//    wrong a second way - this comment is the tell if a future edit reverses
//    boatYawOffset back and forgets this file exists.
//
// 2. NO CARVE BONUS. boatCarveTurn is 1.0 - Shift buys nothing extra for a
//    keel. check-ride.mjs asserts carveGain > 1.3; this file asserts the
//    opposite, that it stays near 1.0, so a regression that accidentally
//    wires the ski's carve gain onto the boat is caught rather than praised.
//
// 3. NEVER AIRBORNE. The launch is deliberately unreachable (three independent
//    guards in presets.js: boatLaunch 0, boatJumpSpeed 999, boatJumpGain 0) -
//    a displacement hull does not leave the water. Asserted here, not just
//    reported, because "never airborne" is the entire point of tuning a
//    second WaveRunner instance this way instead of reusing the ski's numbers.
//
// 4. THE HULL DISPLACES WATER THROUGH THE SHARED hull OBJECT, same as the ski
//    - hull.push/hull.plane are stamped from `veh`, whichever craft is active,
//    so this is the regression guard that boat.active actually routes there.

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
await page.evaluate(() => { const A = window.abyssal;
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.25; A.params.cloudSteps = 6; });

// Sample from inside the frame callback so every frame is seen - the same
// reason check-ride.mjs samples here rather than polling.
await page.evaluate(() => {
  const A = window.abyssal;
  A.__log = [];
  const norm = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  // Mirrors three-main.js's remapParams() exactly - the boat IS a WaveRunner
  // reading wrFoo fields, and boatParams is what redirects those onto the
  // boatFoo preset values without a second physics model. Duplicated here,
  // not imported, because this runs inside the page against the BUILT
  // bundle, not against source modules.
  const remapParams = (p, from, to) => new Proxy(p, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith(from)) {
        const mapped = to + prop.slice(from.length);
        if (mapped in target) return target[mapped];
      }
      return target[prop];
    },
  });
  const boatParams = remapParams(A.params, 'wr', 'boat');
  // TIME ACCELERATION, same reasoning as check-fly.mjs: physics is pure CPU
  // code, so a software rasteriser under 2 fps can still simulate a hull that
  // is deliberately slow to come up to speed (boatAccel 3.5, a fraction of
  // the ski's) reaching a steady turn inside a check that still runs in
  // seconds, not minutes. Sampled BEFORE the extra steps, so cam3 -
  // rasterised from the state the MAIN update produced - is never compared
  // against a rig the extra steps have already moved past.
  const EXTRA = 9;
  A.onFrame = () => {
    const b = A.boat, c = A.cam3;
    if (!b.active) return;
    const e = A.boatMesh.matrix.elements;
    const want = [Math.sin(b.heading), -Math.cos(b.heading)];
    const nz = norm([e[8], e[10]]), nx = norm([e[0], e[2]]);
    A.__log.push({
      // RAW z column, matching check-ride.mjs - see header note 1.
      alignZ: nz[0] * want[0] + nz[1] * want[1],
      alignX: nx[0] * want[0] + nx[1] * want[1],
      offAxis: Math.min(Math.abs(want[0]), Math.abs(want[1])),
      d: Math.hypot(c.position.x - b.pos[0], c.position.z - b.pos[2]),
      dy: c.position.y - (b.deckY ?? 0),
      rigErr: b.camRig
        ? Math.hypot(c.position.x - b.camRig[0], c.position.y - b.camRig[1], c.position.z - b.camRig[2])
        : 0,
      yaw: Math.abs(b.yawRate),
      sp: Math.abs(b.speed),
      air: b.airborne ? 1 : 0,
      deckY: b.deckY, surf: b.probeH?.[0] ?? NaN,
      upErr: Math.hypot(
        c.matrixWorld.elements[4] - A.camera.up[0],
        c.matrixWorld.elements[5] - A.camera.up[1],
        c.matrixWorld.elements[6] - A.camera.up[2],
      ),
      hullPush: A.hull.push, hullPlane: A.hull.plane,
      finite: [b.pos[0], b.pos[1], b.pos[2], b.heading, b.speed].every(Number.isFinite) ? 1 : 0,
    });
    for (let i = 0; i < EXTRA; i++) b.update(1 / 20, boatParams, A.camera.keys, A.camera);
  };
});

const keys = (add) => page.evaluate((a) => {
  for (const k of a) window.abyssal.camera.keys.add(k);
  window.abyssal.__log.length = 0;
}, add);
const take = () => page.evaluate(() => window.abyssal.__log.slice());
const wait = (ms) => page.waitForTimeout(ms);

await page.evaluate(() => window.abyssal.toggleBoat());
await keys(['KeyW']);                 // build up to speed
await wait(LEG);
await keys(['KeyD']);                 // a steady corner
await wait(LEG);
const plain = await take();
await keys(['ShiftLeft']);            // the same corner, Shift held - should not matter
await wait(LEG);
const carve = await take();

const settled = (rows) => rows.slice(Math.floor(rows.length / 2));
const statAll = (rows, f) => {
  const v = rows.map(f).filter(Number.isFinite);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
  return { n: v.length, mean, max: Math.max(...v), min: Math.min(...v) };
};
const stat = (rows, f) => {
  const v = settled(rows).map(f).filter(Number.isFinite);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
  return { n: v.length, mean, max: Math.max(...v), min: Math.min(...v) };
};

const leg = (rows) => ({
  d: stat(rows, (r) => r.d), dy: stat(rows, (r) => r.dy),
  rigErr: stat(rows, (r) => r.rigErr), yaw: stat(rows, (r) => r.yaw),
  speed: stat(rows, (r) => r.sp), airFrac: stat(rows, (r) => r.air).mean,
  alignZ: statAll(rows, (r) => r.alignZ), alignX: statAll(rows, (r) => r.alignX),
  offAxis: statAll(rows, (r) => r.offAxis),
  upErr: stat(rows, (r) => r.upErr),
  hullPush: stat(rows, (r) => r.hullPush), hullPlane: stat(rows, (r) => r.hullPlane),
  floatDiff: statAll(rows, (r) => Math.abs(r.deckY - r.surf)),
  allFinite: rows.every((r) => r.finite === 1),
});

const D = await page.evaluate(() => window.abyssal.params.boatCamDistance);
const out = { plain: leg(plain), carve: leg(carve), camDistance: D, carveGain: 0 };
out.carveGain = out.carve.yaw.mean / Math.max(out.plain.yaw.mean, 1e-3);
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1));

const fails = [];
const need = (cond, msg) => { if (!cond) fails.push(msg); };
need(plain.length > 4 && carve.length > 4, 'not enough frames sampled');
need(out.plain.rigErr.max < 0.05, `camera ${out.plain.rigErr.max.toFixed(2)} m off its rig under throttle+steer`);
need(out.carve.rigErr.max < 0.05, `camera ${out.carve.rigErr.max.toFixed(2)} m off its rig with Shift held`);
need(out.plain.speed.mean > 0.5, `barely moving (mean speed ${out.plain.speed.mean.toFixed(2)} m/s)`);
need(out.plain.yaw.mean > 0.01 || out.carve.yaw.mean > 0.01, 'never turned under steer');
// Displacement hull: never leaves the water, and Shift changes nothing about
// how hard it turns - see header notes 2 and 3.
need(out.plain.airFrac === 0 && out.carve.airFrac === 0, 'the boat left the water - the launch guards regressed');
need(out.carveGain > 0.7 && out.carveGain < 1.4,
  `Shift changed the turn rate ${out.carveGain.toFixed(2)}x - the boat should not carve`);
need(Math.max(out.carve.offAxis.max, out.plain.offAxis.max) > 0.3, 'boat never turned off-axis, so heading proves nothing');
need(Math.min(out.carve.alignZ.min, out.plain.alignZ.min) > 0.99, `bow not along travel (worst ${Math.min(out.carve.alignZ.min, out.plain.alignZ.min).toFixed(3)})`);
need(Math.max(out.plain.floatDiff.max, out.carve.floatDiff.max) < 6, 'boat is not floating near the water surface it is over');
need(out.plain.hullPush.mean > 0 && out.plain.hullPlane.mean > 0, 'hull is not displacing water while the boat drives');
need(out.plain.allFinite && out.carve.allFinite, 'NaN in the boat state');
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'BOAT FAILED\n  ' + fails.join('\n  ') : 'BOAT OK');
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
