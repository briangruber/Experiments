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
await page.evaluate(() => { window.abyssal.params.renderScale = 0.25; window.abyssal.params.cloudSteps = 6; });

await page.evaluate(() => {
  const A = window.abyssal;
  A.__log = [];
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
      heading: p.heading, roll: p.roll, gamma: p.gamma, throttle: p.throttle,
      surf: p.probeH[0],
      camD: Math.hypot(c.position.x - p.pos[0], c.position.z - p.pos[2]),
      rigErr: p.camRig
        ? Math.hypot(c.position.x - p.camRig[0], c.position.y - p.camRig[1], c.position.z - p.camRig[2])
        : 0,
      finite: [p.va, p.pos[0], p.pos[1], p.pos[2], p.heading, p.roll, p.gamma].every(Number.isFinite) ? 1 : 0,
    });
    for (let i = 0; i < EXTRA; i++) p.update(1 / 20, A.params, A.camera.keys, A.camera);
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

const out = {
  frames: all.length,
  taxi: { frames: run.length, liftoffFrame: takeoffIdx, vAtLiftoff: +vAtLiftoff?.toFixed(1), spTakeoff },
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
