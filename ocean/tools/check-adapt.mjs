#!/usr/bin/env node
// Does the frame-rate governor actually trim, and does trimming actually help?
//
//   node tools/check-adapt.mjs
//
// The three demo shipped WITHOUT the raw-GL demo's adaptQuality, so a slow
// device sat at whatever the fixed settings cost - reported as 19 fps on a
// phone. This drives the built bundle on a deliberately overloaded rig and
// asserts the loop closes:
//
//   1. it TRIMS - renderScale falls toward its floor while the frame rate is
//      under target, and the ladder is spent in order (pixels, then cloud
//      steps, then the grid);
//   2. it HELPS - the frame rate after trimming is measurably better than the
//      same scene with the governor switched off. Without this the check would
//      pass on a governor that moved numbers and changed nothing;
//   3. it STOPS - nothing runs past its floor, so quality cannot spiral to
//      zero on a device that can never hit the target.

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
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/?backend=webgl`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 120000 });

const measure = (secs) => page.evaluate((s) => new Promise((res) => {
  const A = window.abyssal; let n = 0;
  const prev = A.onFrame; const t0 = performance.now();
  A.onFrame = () => { n++; prev?.(); };
  setTimeout(() => { A.onFrame = prev; res({ fps: n / ((performance.now() - t0) / 1000), frames: n }); }, s * 1000);
}), secs);

// ---- control: the same scene with the governor OFF -------------------------
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.85; A.params.cloudStepScale = 1; A.params.gridScale = 1;
  A.toggleRide();
});
await page.waitForTimeout(35000);                 // past pipeline compilation
const off = await measure(10);
const offState = await page.evaluate(() => ({
  renderScale: +window.abyssal.params.renderScale.toFixed(3),
}));

// ---- now let it govern -----------------------------------------------------
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.renderScale = 0.85; A.params.cloudStepScale = 1; A.params.gridScale = 1;
  A.params.adaptiveQuality = 1;
});
await page.waitForTimeout(30000);                 // long enough to walk the ladder
const on = await measure(10);
const onState = await page.evaluate(() => {
  const p = window.abyssal.params;
  return {
    renderScale: +p.renderScale.toFixed(3), renderScaleMin: p.renderScaleMin,
    cloudStepScale: +p.cloudStepScale.toFixed(3), cloudStepMin: p.cloudStepMin,
    gridScale: +p.gridScale.toFixed(3), gridScaleMin: p.gridScaleMin,
    targetFps: p.targetFps,
  };
});

const out = {
  governorOff: { fps: +off.fps.toFixed(2), frames: off.frames, renderScale: offState.renderScale },
  governorOn: { fps: +on.fps.toFixed(2), frames: on.frames, ...onState },
  speedup: +(on.fps / Math.max(off.fps, 1e-6)).toFixed(2),
};
console.log(JSON.stringify(out, null, 1));

const fails = [];
const need = (c, m) => { if (!c) fails.push(m); };
need(off.frames > 4 && on.frames > 4, 'not enough frames to compare');
need(onState.renderScale < offState.renderScale - 0.05,
  `governor did not trim (renderScale ${offState.renderScale} -> ${onState.renderScale})`);
need(on.fps > off.fps * 1.15,
  `trimming did not help (${off.fps.toFixed(2)} -> ${on.fps.toFixed(2)} fps)`);
need(onState.renderScale >= onState.renderScaleMin - 1e-6, 'renderScale ran below its floor');
need(onState.cloudStepScale >= onState.cloudStepMin - 1e-6, 'cloudStepScale ran below its floor');
need(onState.gridScale >= onState.gridScaleMin - 1e-6, 'gridScale ran below its floor');
// The ladder is ordered: nothing later is spent while something earlier is left.
need(!(onState.cloudStepScale < 1 && onState.renderScale > onState.renderScaleMin + 1e-6),
  'spent cloud steps while pixels were still available');
need(!(onState.gridScale < 1 && onState.cloudStepScale > onState.cloudStepMin + 1e-6),
  'spent the grid while cloud steps were still available');
need(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));

console.log(fails.length ? 'ADAPT FAILED\n  ' + fails.join('\n  ') : 'ADAPT OK');
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
