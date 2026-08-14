#!/usr/bin/env node
// Does the craft actually appear in the water?
//
//   node tools/check-reflection.mjs
//
// A/B the built bundle with params.craftReflect at 0 and 1 and diff the frames.
//
// THE CONTROL IS THE POINT. The first version of this measurement compared two
// screenshots taken 2.5 s apart and reported 57% of all pixels changed - which
// says nothing, because the sea is alive and every pixel of it moves between
// any two frames. Freezing needs more than timeScale (that left 24k pixels
// still moving); the simulation, the vehicle and the particles all have to be
// stopped outright. So this takes THREE shots - off, on, off - and requires the
// on/off difference to stand well clear of the off/off control.

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
const page = await browser.newPage({ viewport: { width: 560, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/?backend=webgl&keepbuffer=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });

await page.evaluate(() => {
  const A = window.abyssal;
  A.applyPreset('Sheltered Water');     // calm water holds a legible image
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.4; A.params.cloudSteps = 8;
  A.params.sprayOpacity = 0;            // no billboards in the diff
  A.params.sdEnabled = 0;               // the dragon swims; this frame must not
  A.toggleFly();
});
// FLY, don't float. The reported case is an aircraft in the air - the shadow
// only exists there, and the reflection has to survive the altitude fade to be
// worth anything. Six metres is the low pass the report described. Posed rather than flown so the frozen sea below is a valid
// control.
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const A = window.abyssal, p = A.plane;
  A.onFrame = () => {
    p.airborne = true; p.va = 45; p.gamma = 0; p.roll = 0;
    p.pos[1] = p.probeH[0] + 6;
  };
});
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.timeScale = 0;
  // AND THE IRIS. The auto-exposure keeps adapting on real dt whatever the sim
  // does, so with it live every pixel of every shot differs from every other -
  // measured as a control of 201590 of 201600 pixels, which is the whole frame.
  // A fixed iris is the only way two frames of this renderer are comparable.
  A.params.autoExposure = 0;
  A.sim.update = () => {};
  A.plane.update = () => {};
  A.spray.update = () => {};
  // The wake field keeps diffusing on its own, and it is the only thing left
  // moving once the sim, the aircraft and the particles are stopped: with it
  // live the off/off control ran at 490 changed pixels, which is a third of the
  // effect being measured.
  A.wake.update = () => {};
});
await page.waitForTimeout(6000);
await page.evaluate(() => { const h = document.getElementById('hud'); if (h) h.style.display = 'none'; });

const shots = {};
// Reflection and shadow are measured SEPARATELY against the same frozen frame,
// each with the other switched off, so neither can be credited with the other's
// pixels. Both are bracketed by the same off/off control.
for (const [refl, shad, name] of [
  [0, 0, 'off'], [1, 0, 'on'], [0, 1, 'shadow'], [0, 0, 'off2'],
]) {
  await page.evaluate(([r, s]) => {
    window.abyssal.params.craftReflect = r;
    window.abyssal.params.craftShadow = s;
  }, [refl, shad]);
  await page.waitForTimeout(2500);
  shots[name] = await page.screenshot({ timeout: 90000, animations: 'disabled' });
}
const state = await page.evaluate(() => ({
  size: window.abyssal.ctx.craftReflSize,
  y: window.abyssal.plane.pos[1],
}));
await browser.close();
server.close();

// Decode the PNGs with the browser's own decoder rather than adding a codec.
const b2 = await launchChromium();
const p2 = await b2.newPage();
const stats = await p2.evaluate(async ({ off, on, off2, shadow }) => {
  const load = async (b64) => {
    const raw = atob(b64); const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return { d: c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  };
  const A = await load(off), B = await load(on), C = await load(off2), D = await load(shadow);
  const count = (X, Y) => {
    let n = 0, max = 0, sx = 0, sy = 0;
    const xs = [], ys = [];
    for (let i = 0; i < X.d.length; i += 4) {
      const dd = (Math.abs(X.d[i] - Y.d[i]) + Math.abs(X.d[i + 1] - Y.d[i + 1]) + Math.abs(X.d[i + 2] - Y.d[i + 2])) / 3;
      if (dd > 2) {
        n++; const px = (i / 4) % X.w, py = Math.floor((i / 4) / X.w); sx += px; sy += py;
        xs.push(px); ys.push(py);
      }
      if (dd > max) max = dd;
    }
    // A PERCENTILE bounding box, not a min/max one. The control still leaves a
    // couple of hundred pixels scattered across the frame, and one of them at a
    // far corner inflates a min/max box until every shape looks sparse inside it.
    xs.sort((p, q) => p - q); ys.sort((p, q) => p - q);
    const q = (arr, f) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0);
    const box = n ? (q(xs, 0.98) - q(xs, 0.02) + 1) * (q(ys, 0.98) - q(ys, 0.02) + 1) : 0;
    return {
      n, max, cx: sx / Math.max(n, 1), cy: sy / Math.max(n, 1),
      total: X.d.length / 4, h: X.h, fill: n / Math.max(box, 1),
    };
  };
  return { control: count(A, C), effect: count(A, B), shadow: count(A, D) };
}, { off: shots.off.toString('base64'), on: shots.on.toString('base64'),
     off2: shots.off2.toString('base64'), shadow: shots.shadow.toString('base64') });
await b2.close();

const { control, effect, shadow } = stats;
console.log(JSON.stringify({
  proxyRadius: +state.size.toFixed(2), craftY: +state.y.toFixed(2),
  control: { changed: control.n, max: +control.max.toFixed(1) },
  effect: { changed: effect.n, max: +effect.max.toFixed(1), centroidY: +effect.cy.toFixed(0), frameH: effect.h },
  shadow: {
    changed: shadow.n, max: +shadow.max.toFixed(1), centroidY: +shadow.cy.toFixed(0),
    fill: +shadow.fill.toFixed(2),
  },
}, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(effect.n > control.n * 4, `reflection changed ${effect.n} px against a control of ${control.n} - not clear of the noise`);
need(effect.n > 2000, `reflection barely visible (${effect.n} px changed)`);
need(effect.n < effect.total * 0.35, `reflection changed ${effect.n} of ${effect.total} px - it is smearing over the whole sea`);
// The image belongs BELOW the horizon, under the craft - not in the sky.
need(effect.cy > effect.h * 0.45, `reflection centroid at y=${effect.cy.toFixed(0)} of ${effect.h} - above the waterline`);
// The shadow is its own claim, measured with the reflection switched off.
// The shadow is still measured here - it has to survive the same frozen frame -
// but only for EXISTENCE. From the chase view it covers a few hundred pixels,
// which is the same order as this frame's residual noise, and no threshold that
// loose can tell an airframe from a blob. That claim belongs to
// tools/check-shadow.mjs, which looks straight down at it.
need(shadow.n > control.n * 2, `shadow changed ${shadow.n} px against a control of ${control.n}`);
need(shadow.cy > shadow.h * 0.45, `shadow centroid at y=${shadow.cy.toFixed(0)} - above the waterline`);
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'REFLECTION FAILED\n  ' + fails.join('\n  ') : 'REFLECTION OK');
process.exit(fails.length ? 1 : 0);
