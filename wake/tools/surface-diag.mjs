#!/usr/bin/env node
// Why is the surface sim empty? Three questions, asked of the running page:
//  1. are there any SOURCES this frame (nSplat, wet stations, landings)?
//  2. after one step, is there ANYTHING in the texture, anywhere (max over all)?
//  3. does the field's own texture have content (so the read path is sane)?
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try { const u = decodeURIComponent(q.url.split('?')[0]); const f = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); r.end(await readFile(f));
  } catch { r.writeHead(404).end(); } });
await new Promise((r) => server.listen(0, r));
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 400, height: 260 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?prewarm=20&boat.speed=10`);
await page.waitForFunction(() => window.__wake?.surface, null, { timeout: 120000 });
// Let the model load and a few real frames run.
await page.waitForTimeout(8000);
const out = await page.evaluate(() => {
  const W = window.__wake;
  const { surface, wake, renderer, state, stepSim, feedSurface, spray, get } = W;
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024); if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024); };
  const maxOf = (rt) => { const N = rt.width; const b = new Uint16Array(N * N * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, b);
    let mx = [0, 0, 0, 0], nz = 0; for (let i = 0; i < b.length; i += 4) { for (let c = 0; c < 4; c++) mx[c] = Math.max(mx[c], h2f(b[i + c])); if (h2f(b[i]) > 0.001) nz++; }
    return { max: mx.map((v) => +v.toFixed(4)), nonzeroFoamTexels: nz }; };
  // One controlled step.
  stepSim(1 / 30);
  spray.step(1 / 30, () => 0);
  feedSurface(1 / 30);
  const nSplat = surface.nSplat;
  surface.step(1 / 30);
  const afterSources = maxOf(surface.rt[surface.i]);
  // THE DECISIVE TEST: a splat by hand, no sources involved. If this is still
  // zero the render pass itself writes nothing and the sources are innocent.
  surface.begin();
  surface.splat(state.x, state.z, 0, 1, 6, 6, 1.0, 1.0, 1.0);
  const manualN = surface.nSplat;
  surface.step(1 / 30);
  const afterManual = maxOf(surface.rt[surface.i]);
  // DID THE DRAW EVEN HAPPEN? Triangle counts around each pass, then the same
  // manual splat under three blend states. If no state lands a pixel the
  // fragment never reached the target; if one does, it is the blend.
  const mesh = surface.splatScene.children[0];
  const tri = () => renderer.info.render.triangles;
  const trial = (label, mutate) => {
    mutate(mesh.material); mesh.material.needsUpdate = true;
    surface.begin(); surface.splat(state.x, state.z, 0, 1, 6, 6, 1.0, 1.0, 1.0);
    renderer.info.reset(); const t0 = tri();
    surface.step(1 / 30);
    return { label, trianglesDrawn: tri() - t0, calls: renderer.info.render.calls,
             max: maxOf(surface.rt[surface.i]).max };
  };
  const trials = [
    trial('custom One/One (as built)', (m) => {}),
    trial('AdditiveBlending(2) transparent', (m) => { m.blending = 2; m.transparent = true; }),
    trial('NoBlending(0) opaque write', (m) => { m.blending = 0; m.transparent = false; }),
  ];
  // And the step pass alone, seeded: does a plain write via the step shader land?
  return {
    trials,
    afterSources, manualN, afterManual,
    drawRange: surface.splatGeo.drawRange.count,
    splatPos0: Array.from(surface.pos.slice(0, 12)).map((v) => +v.toFixed(2)),
    camPos: [wake.camera.position.x, wake.camera.position.y, wake.camera.position.z],
    camNearFar: [wake.camera.near, wake.camera.far],
    camBounds: [wake.camera.left, wake.camera.right, wake.camera.top, wake.camera.bottom],
    speed: +state.speed.toFixed(2),
    simOn: get('sim.on'), waterlineGain: get('sim.waterline'),
    wetStations: W.hullNow ? undefined : undefined,
    hullNow: W.hullNow,
    nSplat,
    landings: spray.landings.length / 3,
    fieldTex: maxOf(wake.rt),
    surfaceCenter: [surface.center.x, surface.center.y], fieldCenter: [wake.center.x, wake.center.y],
    extent: [surface.extent, wake.extent],
  };
});
await browser.close(); server.close();
console.log(JSON.stringify(out, null, 2));
if (errs.length) console.log('PAGE ERRORS:', errs);
