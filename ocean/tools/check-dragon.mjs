#!/usr/bin/env node
// Is the sea dragon there, is it swimming, and can you ride up next to it?
//
//   node tools/check-dragon.mjs
//
// Three claims, because the animal can fail three separate ways and two of them
// look fine in a still:
//
//   VISIBLE   it is drawn INTO the sea. The ocean is opaque and writes depth,
//             so the whole thing hangs on the draw order and the blend in
//             src/gpu/tsl/creature.js; get either wrong and it is simply gone,
//             or - worse - painted over the sky.
//   SWIMMING  the body wave advances and the tail beats faster when it sprints.
//             prototypes/dragon-swim.html pins the SHAPE of the wave; this pins
//             that the app is actually driving it.
//   ALONGSIDE it holds a station off a moving ski. This is the whole request
//             ("swim fast next to our wave runner so we can ride up next to
//             it"), and it is the part a screenshot cannot show: a dragon that
//             is left behind at 14 m/s is one you never see twice.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PAGE = opt('page', 'dist/abyssal-three.html');

const server = createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(ROOT, PAGE)));
  } catch (e) { res.writeHead(404).end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/?backend=webgl&keepbuffer=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });

await page.evaluate(() => {
  const A = window.abyssal;
  A.applyPreset('Sheltered Water');
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.5; A.params.cloudSteps = 8;
  A.params.sprayOpacity = 0;
  A.params.craftShadow = 0; A.params.craftReflect = 0;   // other people's claims
  A.toggleRide();
});
await page.waitForTimeout(2500);

// ---- ALONGSIDE ------------------------------------------------------------
// Drive the ski at a steady speed and heading from onFrame (which runs before
// the dragon's own update, so it is chasing a genuinely moving target) and
// watch the gap it settles at. The ski is driven rather than "flown" by the
// physics so the run is repeatable.
await page.evaluate(() => {
  const A = window.abyssal, r = A.rider;
  A.rider.update = () => {};       // hold the ski's own physics out of it
  A.onFrame = () => {
    r.active = true;
    r.speed = 14; r.heading += 0.06 * (1 / 30);      // a long, steady turn
    r.pos[0] += Math.sin(r.heading) * r.speed * (1 / 30);
    r.pos[2] += -Math.cos(r.heading) * r.speed * (1 / 30);
    A.camera.locked = false;
  };
});
await page.waitForTimeout(14000);
const chase = await page.evaluate(() => {
  const A = window.abyssal, d = A.dragon, r = A.rider;
  return {
    gap: +Math.hypot(d.pos[0] - r.pos[0], d.pos[2] - r.pos[2]).toFixed(1),
    station: A.params.sdOffset,
    speed: +d.speed.toFixed(1),
    depth: +(-d.pos[1]).toFixed(2),
    minDepth: A.params.sdMinDepth,
    pacing: d.pacing,
    finite: [d.pos[0], d.pos[1], d.pos[2], d.heading, d.speed, d.phase].every(Number.isFinite),
  };
});

// ---- SWIMMING -------------------------------------------------------------
// The phase must advance, and advance FASTER when the animal is sprinting.
//
// DRIVEN DIRECTLY, not watched over wall-clock. The first version of this timed
// the phase against performance.now() and read 0.13 rad/s - which is not the
// tail beat, it is this sandbox's frame rate: a software rasteriser at about
// one frame a second gets two updates in two and a half seconds, and no model
// on earth looks animated through that. Stepping update() at a fixed dt
// measures radians per SIMULATED second, which is the number the claim is about.
const beat = await page.evaluate(() => {
  const A = window.abyssal, d = A.dragon;
  const held = d.speed, heldPos = [d.pos[0], d.pos[1], d.pos[2]], heldPhase = d.phase;
  const radsPerSecond = (spd) => {
    let sum = 0;
    for (let i = 0; i < 60; i++) {
      d.speed = spd;
      const p0 = d.phase;
      d.update(1 / 60, A.params, null, A.camera);
      sum += d.phase - p0;
    }
    return sum;                       // 60 steps of 1/60 s = one second
  };
  const slow = radsPerSecond(2);
  const fast = radsPerSecond(24);
  d.speed = held; d.phase = heldPhase;
  d.pos[0] = heldPos[0]; d.pos[1] = heldPos[1]; d.pos[2] = heldPos[2];
  return { slow: +slow.toFixed(2), fast: +fast.toFixed(2) };
});

// ---- VISIBLE --------------------------------------------------------------
// Freeze everything that moves, put the camera on the animal, and A/B it with
// sdEnabled. Same recipe as tools/check-shadow.mjs, and for the same reason:
// two unfrozen frames of a live sea differ everywhere.
await page.evaluate(() => {
  const A = window.abyssal, d = A.dragon;
  A.params.timeScale = 0; A.params.autoExposure = 0;
  A.sim.update = () => {};
  A.spray.update = () => {};
  A.wake.update = () => {};
  const hud = document.getElementById('hud'); if (hud) hud.style.display = 'none';
  A.params.sdDepth = 3.5; A.params.sdDepthSwing = 0;
  A.onFrame = () => {
    const c = A.camera;
    c.locked = false;
    // Far enough back and shallow enough that THE HORIZON IS IN FRAME: the sky
    // assertion below is meaningless without it, and the steeper pose this used
    // to have put the skyline off the top of the picture.
    c.pos[0] = d.pos[0] + 26; c.pos[1] = 7; c.pos[2] = d.pos[2] + 26;
    const dx = -26, dy = d.pos[1] - c.pos[1], dz = -26;
    c.yaw = Math.atan2(dx, -dz);
    c.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  };
});
await page.waitForTimeout(9000);
await page.evaluate(() => { window.abyssal.dragon.update = () => {}; });
await page.waitForTimeout(3000);

// WHERE THE HORIZON IS, in rows, computed rather than guessed. The first
// version of this called the top fifth of the frame "sky" and asserted nothing
// changed there. That was a proxy for a failure that no longer exists - the
// animal is composited inside the water shader now, so it cannot reach a sky
// pixel by construction - and worse, it was wrong: this camera looks down hard
// enough that the whole frame is sea, so the moment the sea started LIFTING
// over the animal's back, 8482 legitimately-changed water pixels were reported
// as sky. A camera pitched down by |p| puts the horizon tan|p|/tan(fov/2) of a
// half-frame above centre.
const horizonRow = await page.evaluate(() => {
  const A = window.abyssal, c = A.camera;
  const half = Math.tan((c.fov * Math.PI / 180) / 2);
  const ndc = Math.tan(Math.max(0, -c.pitch)) / half;
  return { frac: (1 - Math.min(ndc, 1)) / 2, offScreen: ndc >= 1 };
});

const shots = {};
for (const [on, name] of [[1, 'on'], [0, 'off'], [0, 'off2']]) {
  await page.evaluate((v) => { window.abyssal.params.sdEnabled = v; }, on);
  await page.waitForTimeout(2500);
  shots[name] = await page.screenshot({ timeout: 90000, animations: 'disabled' });
}
await browser.close();
server.close();

const b2 = await launchChromium();
const p2 = await b2.newPage();
const pix = await p2.evaluate(async ({ on, off, off2, horizon }) => {
  const load = async (b64) => {
    const raw = atob(b64); const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return { d: c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  };
  const A = await load(on), B = await load(off), C = await load(off2);
  const count = (X, Y) => {
    let n = 0, sky = 0, sum = 0, peak = 0;
    for (let i = 0; i < X.d.length; i += 4) {
      const dd = (Math.abs(X.d[i] - Y.d[i]) + Math.abs(X.d[i + 1] - Y.d[i + 1]) + Math.abs(X.d[i + 2] - Y.d[i + 2])) / 3;
      if (dd <= 2) continue;
      n++; sum += dd; if (dd > peak) peak = dd;
      // Above the horizon is sky, and nothing submerged may touch it. Two rows
      // of margin for the horizon's own antialiasing.
      if (Math.floor((i / 4) / X.w) < X.h * horizon - 2) sky++;
    }
    return { n, sky, mean: +(sum / Math.max(n, 1)).toFixed(1), peak: +peak.toFixed(0) };
  };
  return { control: count(B, C), effect: count(A, B) };
}, {
  on: shots.on.toString('base64'), off: shots.off.toString('base64'),
  off2: shots.off2.toString('base64'), horizon: horizonRow.frac,
});
await b2.close();

const { control, effect } = pix;
console.log(JSON.stringify({ chase, beat, horizonRow, control, effect }, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(chase.finite, 'the dragon\'s state went non-finite');
need(chase.pacing, `it was not pacing a ski doing ${14} m/s`);
need(chase.gap < chase.station * 2.2, `it settled ${chase.gap} m from a ski it is meant to hold ${chase.station} m off`);
need(chase.gap > 2, `it settled ${chase.gap} m away - that is close enough to ride through`);
need(chase.depth >= chase.minDepth - 0.05, `it came up to ${chase.depth} m, past the ${chase.minDepth} m it must stay under`);
need(beat.slow > 1.5, `the body wave is not advancing (${beat.slow} rad/s of simulated time at a cruise)`);
need(beat.fast > beat.slow * 1.15, `the tail does not beat faster when it sprints (${beat.slow} -> ${beat.fast} rad/s)`);
need(effect.n > control.n * 6, `the dragon changed ${effect.n} px against a control of ${control.n} - not clear of the noise`);
need(effect.n > 2500, `barely visible in the water (${effect.n} px changed)`);
// HOW HARD it changes them, not just how many. Composited into the sea's
// diffuse term the animal can cover thousands of pixels and still be a whisper
// - which is exactly what "just a transparent ghost" looks like from the other
// direction. 8 levels out of 255 is about where a shape stops being a smudge.
need(effect.mean > 8, `it only shifts the sea by ${effect.mean}/255 where it covers it - too faint to read as a body`);
need(!horizonRow.offScreen, 'the horizon is off the top of this frame - the sky assertion below is measuring nothing');
need(effect.sky < effect.n * 0.02, `${effect.sky} of its ${effect.n} pixels are above the horizon (row ${Math.round(horizonRow.frac * 400)}) - it is reaching the sky`);
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'DRAGON FAILED\n  ' + fails.join('\n  ') : 'DRAGON OK');
process.exit(fails.length ? 1 : 0);
