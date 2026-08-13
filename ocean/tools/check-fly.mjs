#!/usr/bin/env node
// Does the seaplane take off, fly, turn, and come back down?
//
//   node tools/check-fly.mjs
//
// Drives the BUILT bundle through the keyboard, phase by phase, and asserts
// the flight envelope rather than positions: taxi accelerates through the
// drag hump, rotation happens above spTakeoff and NOT before, the climb is
// real altitude gained, a bank turns the heading the same way the stick went,
// and closing the throttle brings it back to the water without a single NaN.
//
// Sampled from inside the frame callback (cam3 and the plane's own state), for
// the same reasons tools/check-ride.mjs documents: every frame is seen, and
// the camera sampled is the one the frame was actually rasterised through.

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
  // A check measures a FIXED configuration. The frame-rate governor would drag
  // renderScale back toward its floor mid-run and quietly change what is being
  // measured - and on this rasteriser it would raise it, since the floor is
  // above the load shed below.
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.25; A.params.cloudSteps = 6; });

await page.evaluate(() => {
  const A = window.abyssal;
  A.__log = [];
  A.__contact = [];
  // TIME ACCELERATION. The physics is pure CPU code, so a software rasteriser
  // at under 2 fps can still simulate a full takeoff run: after sampling, step
  // the plane several extra times at the same clamped dt the main loop uses.
  // The probe readings refresh only once per FRAME, so the water phase rides a
  // slightly staler sea than real time would - acceptable for envelope
  // assertions, and exactly the kind of compromise the header warns about.
  //
  // The sample is taken BEFORE the extra steps on purpose: cam3 was rasterised
  // from the state the MAIN update produced, and comparing it against a rig
  // the extra steps have already moved would report a phantom camera error.
  const EXTRA = 9;
  A.onFrame = () => {
    const p = A.plane, c = A.cam3;
    if (!p.active) return;
    A.__log.push({
      va: p.va, air: p.airborne ? 1 : 0, alt: p.alt, y: p.pos[1],
      x: p.pos[0], z: p.pos[2],
      // Does the nose point where it is going? Read off the model matrix BASIS
      // COLUMNS - never a quaternion; tools/check-ride.mjs explains why. The
      // plane's transform uses modelYaw 0, so the bow is the model's local -Z,
      // i.e. the NEGATED third column.
      align: (() => {
        const e = A.planeMesh.matrix.elements;
        const L = Math.hypot(e[8], e[10]) || 1;
        const w = [Math.sin(p.heading), -Math.cos(p.heading)];
        return (-e[8] / L) * w[0] + (-e[10] / L) * w[1];
      })(),
      heading: p.heading, roll: p.roll, gamma: p.gamma, throttle: p.throttle,
      surf: p.probeH[0],
      contact: p.contact, wingCut: p.wingCut, wetness: p.wetness,
      hullPush: A.hull.push,
      camD: Math.hypot(c.position.x - p.pos[0], c.position.z - p.pos[2]),
      rigErr: p.camRig
        ? Math.hypot(c.position.x - p.camRig[0], c.position.y - p.camRig[1], c.position.z - p.camRig[2])
        : 0,
      finite: [p.va, p.pos[0], p.pos[1], p.pos[2], p.heading, p.roll, p.gamma].every(Number.isFinite) ? 1 : 0,
    });
    // Contact is sampled at every PHYSICS STEP, not once per frame. The frame
    // samples above are 10 steps apart under time acceleration, so a hull can
    // cross the whole contact fade between two of them - the first version of
    // this assertion read that aliasing as a one-frame snap and failed on it.
    A.__contact.push(p.contact);
    for (let i = 0; i < EXTRA; i++) {
      p.update(1 / 20, A.params, A.camera.keys, A.camera);
      A.__contact.push(p.contact);
    }
  };
});

const keys = (add, drop = []) => page.evaluate(([a, d]) => {
  for (const k of a) window.abyssal.camera.keys.add(k);
  for (const k of d) window.abyssal.camera.keys.delete(k);
  window.abyssal.__log.length = 0;
}, [add, drop]);
const take = () => page.evaluate(() => window.abyssal.__log.slice());
const wait = (ms) => page.waitForTimeout(ms);

await page.evaluate(() => window.abyssal.toggleFly());

// Phase 1: full throttle takeoff run, pulling gently.
await keys(['KeyW', 'ShiftLeft']);
await wait(26000);
const run = await take();

// Phase 2: hands off the pull, hold a right bank.
await keys(['KeyD'], ['ShiftLeft']);
await wait(14000);
const turn = await take();

// Phase 3: throttle closed, wings level, push - come back down.
await keys(['ArrowDown', 'KeyS'], ['KeyW', 'KeyD']);
await wait(30000);
const down = await take();

const all = [...run, ...turn, ...down];
const takeoffIdx = run.findIndex((r) => r.air === 1);
const vAtLiftoff = takeoffIdx > 0 ? run[takeoffIdx - 1].va : (takeoffIdx === 0 ? run[0].va : NaN);
const spTakeoff = await page.evaluate(() => window.abyssal.params.spTakeoff);
const maxAlt = Math.max(...all.map((r) => r.alt));
const headings = turn.filter((r) => r.air).map((r) => r.heading);
const headingSwing = headings.length > 1 ? headings[headings.length - 1] - headings[0] : 0;
const rollsInTurn = turn.filter((r) => r.air).map((r) => r.roll);
const landed = down.filter((r) => r.air === 0).length;
const endVa = down.length ? down[down.length - 1].va : NaN;
const maxRigErr = Math.max(...all.map((r) => r.rigErr));
// GROUND DISTANCE COVERED WHILE STILL ON THE WATER. The assertion that was
// missing: a hull can build airspeed without moving, and every other number in
// this report looks healthy while it does.
const wet = run.filter((r) => r.air === 0);
const taxiRun = wet.length > 1
  ? Math.hypot(wet[wet.length - 1].x - wet[0].x, wet[wet.length - 1].z - wet[0].z) : 0;
const worstAlign = Math.min(...all.map((r) => r.align));
// THE SEA MUST NOT SNAP. The hollow the floats press used to be a boolean -
// full depth one frame, zero the next, at every takeoff and touchdown - which
// is what heaved the ocean under the aircraft. Contact is continuous now, so
// the biggest single-frame step in the hollow is the measure of it. The plane
// crosses the boundary in both directions during this run.
const contactSeries = await page.evaluate(() => window.abyssal.__contact.slice());
let worstContactStep = 0;
for (let i = 1; i < contactSeries.length; i++) {
  worstContactStep = Math.max(worstContactStep, Math.abs(contactSeries[i] - contactSeries[i - 1]));
}
const maxPush = Math.max(...all.map((r) => r.hullPush));

const out = {
  frames: all.length,
  taxi: { frames: run.length, liftoffFrame: takeoffIdx, vAtLiftoff: +vAtLiftoff?.toFixed(1), spTakeoff,
          groundRun: +taxiRun.toFixed(1) },
  nose: { worstAlign: +worstAlign.toFixed(4) },
  water: {
    maxHullPush: +maxPush.toFixed(3),
    contactSteps: contactSeries.length,
    worstContactStep: +worstContactStep.toFixed(3),
    contactSpan: [+Math.min(...contactSeries).toFixed(2), +Math.max(...contactSeries).toFixed(2)],
    maxWingCut: +Math.max(...all.map((r) => r.wingCut)).toFixed(2),
  },
  climb: { maxAlt: +maxAlt.toFixed(1) },
  turn: {
    n: headings.length,
    headingSwing: +headingSwing.toFixed(3),
    meanRoll: +(rollsInTurn.reduce((a, b) => a + b, 0) / Math.max(rollsInTurn.length, 1)).toFixed(3),
  },
  descent: { framesOnWater: landed, endVa: +endVa.toFixed(1), endAir: down.length ? down[down.length - 1].air : -1 },
  camera: { maxRigErr: +maxRigErr.toFixed(3) },
  allFinite: all.every((r) => r.finite === 1),
};
console.log(JSON.stringify(out, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(all.length > 20, 'not enough frames sampled');
need(takeoffIdx > 0, 'never lifted off (or spawned airborne)');
need(vAtLiftoff >= spTakeoff * 0.92, `lifted off at ${vAtLiftoff} m/s, below rotation speed ${spTakeoff}`);
need(maxAlt > 8, `never climbed (max float clearance ${maxAlt.toFixed(1)} m)`);
// It has to TAXI, not just spin its airspeed up on the spot. A run to 23 m/s
// cannot happen in less than a few hundred metres of water.
need(taxiRun > 150, `covered only ${taxiRun.toFixed(1)} m of water before lifting off`);
need(worstAlign > 0.99, `nose not along travel (worst ${worstAlign.toFixed(3)})`);
// The hollow is shallower than the wave runner's and never steps by more than
// a fraction of its own depth in one frame. dt is clamped to 1/20 s and the
// contact fade is ~1.8 m, so a legitimate frame cannot cross it.
need(maxPush < 0.45, `float hollow ${maxPush.toFixed(2)} m is too deep for a floatplane`);
// Contact must be CONTINUOUS across the takeoff and the landing this run makes.
// dt is clamped to 1/20 s and the fade is ~1.8 m, so even a 15 m/s departure
// moves it by well under half.
need(contactSeries.length > 50, 'not enough physics steps to judge continuity');
need(Math.min(...contactSeries) < 0.1 && Math.max(...contactSeries) > 0.9,
  'the run never crossed the waterline, so continuity was not tested');
need(worstContactStep < 0.6,
  `contact stepped ${worstContactStep.toFixed(2)} in one physics step - the sea will snap`);
// Stick right = roll negative (right wing down) = heading increasing.
need(headings.length > 3, 'no airborne frames in the turn phase');
need(headingSwing > 0.15, `right bank did not turn right (heading moved ${headingSwing.toFixed(3)})`);
need(rollsInTurn.length && rollsInTurn.every((r) => r < 0.05), 'right stick did not put the right wing down');
need(landed > 2, 'never came back to the water');
need(out.camera.maxRigErr < 0.05, `camera ${maxRigErr.toFixed(2)} m off its rig`);
need(out.allFinite, 'NaN in the flight state');
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'FLY FAILED\n  ' + fails.join('\n  ') : 'FLY OK');
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
