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
  A.toggleFly();
});
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.timeScale = 0;
  A.sim.update = () => {};
  A.plane.update = () => {};
  A.spray.update = () => {};
});
await page.waitForTimeout(3000);
await page.evaluate(() => { const h = document.getElementById('hud'); if (h) h.style.display = 'none'; });

const shots = {};
for (const [amt, name] of [[0, 'off'], [1, 'on'], [0, 'off2']]) {
  await page.evaluate((a) => { window.abyssal.params.craftReflect = a; }, amt);
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
const stats = await p2.evaluate(async ({ off, on, off2 }) => {
  const load = async (b64) => {
    const raw = atob(b64); const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return { d: c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  };
  const A = await load(off), B = await load(on), C = await load(off2);
  const count = (X, Y) => {
    let n = 0, max = 0, sx = 0, sy = 0;
    for (let i = 0; i < X.d.length; i += 4) {
      const dd = (Math.abs(X.d[i] - Y.d[i]) + Math.abs(X.d[i + 1] - Y.d[i + 1]) + Math.abs(X.d[i + 2] - Y.d[i + 2])) / 3;
      if (dd > 2) { n++; const px = (i / 4) % X.w, py = Math.floor((i / 4) / X.w); sx += px; sy += py; }
      if (dd > max) max = dd;
    }
    return { n, max, cx: sx / Math.max(n, 1), cy: sy / Math.max(n, 1), total: X.d.length / 4, h: X.h };
  };
  return { control: count(A, C), effect: count(A, B) };
}, { off: shots.off.toString('base64'), on: shots.on.toString('base64'), off2: shots.off2.toString('base64') });
await b2.close();

const { control, effect } = stats;
console.log(JSON.stringify({
  proxyRadius: +state.size.toFixed(2), craftY: +state.y.toFixed(2),
  control: { changed: control.n, max: +control.max.toFixed(1) },
  effect: { changed: effect.n, max: +effect.max.toFixed(1), centroidY: +effect.cy.toFixed(0), frameH: effect.h },
}, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(effect.n > control.n * 4, `reflection changed ${effect.n} px against a control of ${control.n} - not clear of the noise`);
need(effect.n > 2000, `reflection barely visible (${effect.n} px changed)`);
need(effect.n < effect.total * 0.35, `reflection changed ${effect.n} of ${effect.total} px - it is smearing over the whole sea`);
// The image belongs BELOW the horizon, under the craft - not in the sky.
need(effect.cy > effect.h * 0.45, `reflection centroid at y=${effect.cy.toFixed(0)} of ${effect.h} - above the waterline`);
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'REFLECTION FAILED\n  ' + fails.join('\n  ') : 'REFLECTION OK');
process.exit(fails.length ? 1 : 0);
