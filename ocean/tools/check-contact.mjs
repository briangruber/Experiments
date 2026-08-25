#!/usr/bin/env node
// What is actually touching the water?
//
//   node tools/check-contact.mjs
//
// The seaplane's contact with the sea used to be the boolean `airborne`, so the
// hollow it pressed switched on and off in a single frame and the ocean heaved
// under it - and a wingtip dragging through the surface in a steep low bank did
// nothing at all, because the aircraft is airborne the whole time. This poses
// the aircraft in three states and checks what the water is told:
//
//   level and clear   nothing touching, no hollow, emitter told it is airborne
//   banked, tip in    spray FROM THE TIP, no hollow (a wing does not displace
//                     the ocean), emitter told it is not airborne
//
// tools/check-fly.mjs covers the third - the floats - and asserts that contact
// is continuous across a real takeoff and landing.
//
// THE POSE IS PINNED THROUGH THE PHYSICS, NOT FROZEN. The first version stubbed
// out plane.update() to hold the aircraft still, which is also the method that
// computes contact and wingCut - so every number it read was the stale value
// from the last frame on the water, and it "failed" on values that were never
// recomputed. And its banked leg posed the aircraft 2.0 m up, which with a CG
// riding 2.05 m above the waterline is simply afloat: it was measuring the
// floats and calling them the wing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchChromium } from '/home/user/Experiments/ocean/tools/browser.mjs';
const ROOT = resolve('/home/user/Experiments/ocean');
const server = createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(await readFile(join(ROOT, 'dist/abyssal-three.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 500, height: 320 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/?backend=webgl`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });
await page.evaluate(() => { const A = window.abyssal;
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.25; A.params.cloudSteps = 6; A.toggleFly(); });
await page.waitForTimeout(4000);

const sample = () => page.evaluate(() => {
  const A = window.abyssal, p = A.plane;
  const tip = [A.ctx.craftPos[0], A.ctx.craftPos[1], A.ctx.craftPos[2]];
  return {
    roll: +p.roll.toFixed(2), wingCut: +p.wingCut.toFixed(2), wetness: +p.wetness.toFixed(2),
    wingWet: +p.wingWet.toFixed(3), wingAt: +p.wingAt.toFixed(2),
    contact: +p.contact.toFixed(2), hullPush: +A.hull.push.toFixed(3),
    wingOut: +p.wingOut.toFixed(2),
    craftAmount: +A.ctx.craftAmount.toFixed(2), craftAir: A.ctx.craftAir,
    // How far the emission point is from the fuselage centreline.
    offset: +Math.hypot(tip[0] - p.pos[0], tip[2] - p.pos[2]).toFixed(2),
    va: +p.va.toFixed(1), halfSpan: +(A.params.spLength * A.params.spHalfSpan).toFixed(2),
    aboveSea: +(p.pos[1] - p.probeH[0]).toFixed(2),
    cg: A.params.spCgHeight, fade: A.params.spContactFade, alt: +p.alt.toFixed(2),
    airborne: p.airborne,
  };
});

// HOLD THE POSE THROUGH THE PHYSICS, do not freeze it. The first version of
// this stubbed out plane.update() to keep the aircraft still - which is also
// the method that computes contact and wingCut, so every number it read was
// the stale value from the last frame on the water. Pinning the pose from
// onFrame lets update() run and recompute against it.
const pin = (height, roll) => page.evaluate(([h, r]) => {
  const A = window.abyssal, p = A.plane;
  A.onFrame = () => {
    // gamma above the touchdown gate (0.02) and alt pinned too: with gamma 0 the
    // airborne branch's landing test can flip the aircraft back into the water
    // branch between the pin and the sample, and then alt reads the float spring
    // while pos[1] reads the pin - two numbers that cannot both be true, which
    // is what a flaky run of this looked like.
    p.airborne = true; p.va = 40; p.roll = r; p.gamma = 0.05; p.vy = 0;
    p.pos[1] = p.probeH[0] + h;
    p.alt = h;
  };
}, [height, roll]);

// Level and well clear: nothing should be touching. The long settle is the
// first leg's alone: it runs straight after boot, when this rasteriser is at
// its slowest, and the pin needs several FRAMES to take - four seconds bought
// two of them and the aircraft was still reporting the contact it had while
// afloat.
await pin(12, 0);
await page.waitForTimeout(12000);
const level = await sample();

// Banked hard, floats CLEAR, tip in. The CG rides spCgHeight (2.05 m) above the
// waterline when floating and contact fades over spContactFade (1.8 m), so the
// floats are only truly clear above ~3.9 m - the first version of this posed the
// aircraft at 2.0 m, which is simply afloat, and measured the floats rather than
// the wing. At 4.5 m with 0.9 rad of bank the tip reaches 6.93*sin(0.9) = 5.4 m
// down: floats clear, half a metre of wingtip in the water.
await pin(4.5, -0.9);
await page.waitForTimeout(4000);
const banked = await sample();

console.log('level  ', JSON.stringify(level));
console.log('banked ', JSON.stringify(banked));
const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(level.wingCut === 0 && level.wetness === 0, 'level and clear, yet something was touching the water');
need(banked.wingCut > 0.1, `a ${Math.abs(banked.roll)} rad bank did not put the tip in (cut ${banked.wingCut} m)`);
need(banked.contact < 0.05, `the floats were still in the water (contact ${banked.contact}) - this leg is not testing the wing`);
need(banked.craftAmount > 0, 'a cutting wingtip threw no spray');
need(banked.craftAir === 0, 'the emitter was told the craft was airborne while its wing was in the water');
// The spray comes from the MIDDLE of the wetted run, so it sits between the
// crossing point and the tip - never outboard of the tip, and never at the root.
need(banked.offset > 0.1 && banked.offset < banked.halfSpan + 0.01,
  `spray came from ${banked.offset} m out; the wetted wing runs to ${banked.halfSpan} m`);
// ...and it sits where that midpoint actually IS: wingAt is measured along the
// banked wing, so its offset from the fuselage on the water is its horizontal
// projection. Asserting against wingAt itself is what let the plume sit a third
// of the wetted run outboard of the water it was supposed to be cutting.
need(Math.abs(banked.offset - banked.wingOut) < 0.01,
  `the emission point (${banked.offset} m out) is not the wetted run's midpoint (${banked.wingOut} m)`);
need(banked.wingOut < banked.wingAt,
  `the plume was not projected onto the water: ${banked.wingOut} m out for a station ${banked.wingAt} m along a banked wing`);
need(banked.hullPush < 0.02, `a cutting wing pressed a ${banked.hullPush} m hollow - it should displace nothing`);
need(errs.length === 0, 'page errors: ' + errs.slice(0, 2).join(' | '));
console.log(fails.length ? 'WING FAILED\n  ' + fails.join('\n  ') : 'WING OK');
await browser.close(); server.close();
process.exit(fails.length ? 1 : 0);
