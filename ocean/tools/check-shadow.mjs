#!/usr/bin/env node
// Is the craft's shadow the craft's SHAPE?
//
//   node tools/check-shadow.mjs
//
// The water used to darken under a proxy sphere tested along the sun: cheap,
// and a soft round blob. It was reported as one ("I don't like the blob
// shadow"), and it is now three's own shadow map - the hull rendered from the
// sun, sampled by the sea. See THE CRAFT'S SHADOW in demo/three-main.js for why
// receiveShadow on the water could not do this and what had to be patched.
//
// A COUNT OF DARKENED PIXELS CANNOT TELL A BLOB FROM AN AIRFRAME, so this
// measures the SHAPE. A disc fills about 0.79 of its own bounding box; a
// silhouette with wings, a tail and two floats fills well under half of one.
// That single number is the difference between what was reported and what
// replaced it, so it is what this asserts.
//
// The camera is pinned looking DOWN at the patch of sea the sun puts the shadow
// on, not at the aircraft: from the chase view the shadow is a few hundred
// pixels and the frame's own residual noise is a third of it. From above it is
// thousands, and the shape is unambiguous. Everything that moves is frozen
// first - the sim, the aircraft, the particles, the wake field and the iris -
// because the sea is alive and two unfrozen frames of it differ everywhere
// (tools/check-reflection.mjs's header carries that lesson in full).
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
const page = await browser.newPage({ viewport: { width: 700, height: 440 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/?backend=webgl&keepbuffer=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });

await page.evaluate(() => {
  const A = window.abyssal;
  A.applyPreset('Sheltered Water');       // calm water holds a legible silhouette
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.5; A.params.cloudSteps = 8;
  A.params.sprayOpacity = 0;              // no billboards in the diff
  A.params.craftReflect = 0;              // the reflection is check-reflection's claim
  A.params.craftShadow = 1;
  A.toggleFly();
});
await page.waitForTimeout(2500);

// Freeze, THEN pin. Stubbing plane.update is also what frees the camera, which
// the aircraft otherwise drives; the pose itself is held from onFrame so the
// aircraft's own state stays consistent frame to frame.
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.timeScale = 0;
  A.params.autoExposure = 0;
  A.sim.update = () => {};
  A.plane.update = () => {};
  A.spray.update = () => {};
  A.wake.update = () => {};
  const hud = document.getElementById('hud'); if (hud) hud.style.display = 'none';
  const p = A.plane, c = A.camera;
  A.onFrame = () => {
    p.airborne = true; p.va = 45; p.gamma = 0; p.roll = 0; p.pitch = 0;
    p.heading = 0.6;
    p.pos[0] = 0; p.pos[2] = 0;
    p.pos[1] = p.probeH[0] + 10;
    c.locked = false;
    const s = A.derived.sunDir;
    const t = [p.pos[0] - s[0] * (10 / s[1]), p.probeH[0], p.pos[2] - s[2] * (10 / s[1])];
    c.pos[0] = t[0] + 13; c.pos[1] = p.probeH[0] + 11; c.pos[2] = t[2] + 13;
    const dx = t[0] - c.pos[0], dy = t[1] - c.pos[1], dz = t[2] - c.pos[2];
    c.yaw = Math.atan2(dx, -dz);
    c.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  };
});
await page.waitForTimeout(8000);

const shots = {};
for (const [on, name] of [[1, 'on'], [0, 'off'], [0, 'off2']]) {
  await page.evaluate((v) => { window.abyssal.params.craftShadow = v; }, on);
  await page.waitForTimeout(3000);
  shots[name] = await page.screenshot({ timeout: 90000, animations: 'disabled' });
}
await browser.close();
server.close();

// Decode with the browser's own decoder rather than adding a codec.
const b2 = await launchChromium();
const p2 = await b2.newPage();
const stats = await p2.evaluate(async ({ on, off, off2 }) => {
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
    let n = 0, sy = 0; const xs = [], ys = [];
    for (let i = 0; i < X.d.length; i += 4) {
      const dd = (Math.abs(X.d[i] - Y.d[i]) + Math.abs(X.d[i + 1] - Y.d[i + 1]) + Math.abs(X.d[i + 2] - Y.d[i + 2])) / 3;
      if (dd <= 2) continue;
      n++; const px = (i / 4) % X.w, py = Math.floor((i / 4) / X.w);
      sy += py; xs.push(px); ys.push(py);
    }
    // A PERCENTILE box, not min/max: one stray pixel in a far corner inflates a
    // min/max box until any shape looks sparse inside it.
    xs.sort((p, q) => p - q); ys.sort((p, q) => p - q);
    const q = (a, f) => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : 0);
    const box = n ? (q(xs, 0.99) - q(xs, 0.01) + 1) * (q(ys, 0.99) - q(ys, 0.01) + 1) : 0;
    return { n, cy: sy / Math.max(n, 1), h: X.h, fill: n / Math.max(box, 1) };
  };
  return { control: count(B, C), shadow: count(A, B) };
}, { on: shots.on.toString('base64'), off: shots.off.toString('base64'), off2: shots.off2.toString('base64') });
await b2.close();

const { control, shadow } = stats;
console.log(JSON.stringify({
  control: { changed: control.n },
  shadow: {
    changed: shadow.n, centroidY: +shadow.cy.toFixed(0), frameH: shadow.h,
    fill: +shadow.fill.toFixed(2),
  },
}, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(shadow.n > control.n * 6, `shadow changed ${shadow.n} px against a control of ${control.n} - not clear of the noise`);
need(shadow.n > 3000, `shadow barely visible (${shadow.n} px changed) from directly above it`);
need(shadow.cy > shadow.h * 0.2, `shadow centroid at y=${shadow.cy.toFixed(0)} of ${shadow.h} - not on the sea`);
need(shadow.fill < 0.55, `the shadow fills ${shadow.fill.toFixed(2)} of its bounding box - that is a blob, not an airframe`);
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'SHADOW FAILED\n  ' + fails.join('\n  ') : 'SHADOW OK');
process.exit(fails.length ? 1 : 0);
