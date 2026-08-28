#!/usr/bin/env node
// Does the wave train actually overtake a stopping hull?
//
// The capture tool drives the boat continuously, where the correct runout is
// zero -- so a clean render there is no evidence at all. This drives her up to
// speed, pulls the throttle, and reads the field texture AHEAD of the bow.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    // Resolve to the FILE first, then take its extension. Doing it the other
    // way round types "/" as octet-stream and the browser downloads the page
    // instead of rendering it.
    const file = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    r.end(await readFile(file));
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const loadPw = async () => {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                   '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean))
    { try { return await import(c); } catch {} }
  throw new Error('playwright not found');
};
const { chromium } = await loadPw();
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 220 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=25&boat.speed=9`, { waitUntil: 'load' });
await page.waitForFunction('window.__wake && window.__wake.wake', { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(2500);
const out = await page.evaluate(async () => {
  const w = window.__wake;
  // Run her up, then chop the throttle and watch the HULL's own height while
  // the train she built catches her up.
  w.set('boat.speed', 9);
  for (let i = 0; i < 240; i++) w.stepSim(1/30);
  w.set('boat.speed', 0);
  const track = [];
  // stepSim advances the physics; it does NOT run the probe, which lives in the
  // render path. Drive it by hand here, or heave simply keeps the value the
  // last real frame left it at -- which is what the first run of this reported,
  // forty identical samples that looked like a dead feature.
  for (let k = 0; k < 40; k++) {
    for (let i = 0; i < 8; i++) w.stepSim(1/30);
    w.wake.update(w.state.t);
    w.body.state = w.state;
    const h = w.sea.probeWaves(w.body.corners(), 8/30);
    w.body.applyWaves(h, w.get('boat.buoy'));
    track.push(+(w.body.wave.heave ?? 0).toFixed(4));
  }
  // The end-to-end response needs real frames -- the probe collects through a
  // fence -- so report what CAN be established here: that the wake is actually
  // reaching the probe's binding.
  const b = w.sea.wake?.probeBinding?.();
  return { bindingOk: !!b, bindingExtent: b?.extent ?? null, bindingOn: b?.on ?? 0,
           note: 'heave needs real frames; fence-based readback', track,
           speed: +w.state.speed.toFixed(2) };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,2));
await browser.close(); server.close();
