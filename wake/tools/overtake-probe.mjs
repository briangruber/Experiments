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
  const w = window.__wake, wake = w.wake;
  const snap = (tag) => ({ tag, runout: +(wake._runout ?? 0).toFixed(2),
    madeV: +(wake._madeV ?? 0).toFixed(2), speed: +w.state.speed.toFixed(2),
    overAmp: +(wake.uniforms.uOverAmp.value ?? 0).toFixed(4) });
  const cruising = snap('cruising');
  // Pull the throttle and let the PAGE run her down in real time.
  //
  // Stepping the sim by hand advances the path and the runout but never calls
  // wake.update(), which is where the uniforms are synced and the field is
  // baked -- so the first version of this read a stale amplitude and a stale
  // texture and reported the feature dead when it had simply never been drawn.
  //
  // Step the PHYSICS by hand, then bake the field explicitly. Waiting on wall
  // clock does not work here: under a software renderer the page manages a few
  // frames a second and each advances about 0.05 s of sim, so 4.5 s of waiting
  // bought under a second of run-down and the boat was still doing 8.7 knots.
  // And stepping alone is not enough either, because the uniforms and the field
  // texture are only brought up to date inside wake.update().
  w.set('boat.speed', 0);
  for (let i = 0; i < 200; i++) w.stepSim(1 / 30);
  w.wake.update(w.state.t);   // the SIM clock in seconds, not wall ms
  const stopped = snap('after a 6.7 s run-down');
  // A/B the field instead of guessing at the texel mapping: the honest question
  // is whether the overtake term contributes anything, and the control is the
  // same instant with it switched off.
  // The WHOLE field, not a window in the middle of it. The field is centred a
  // little ASTERN by design, so a centre crop can miss geometry laid ahead of
  // the bow entirely -- and reading with and without as identical then says
  // nothing except that the crop was in the wrong place.
  const fieldMax = () => {
    const rt = wake.rt, r = w.renderer, N = Math.min(rt.width, rt.height);
    const raw = new Uint16Array(N*N*4);
    const half = (h) => { const s=(h&0x8000)?-1:1, e=(h&0x7C00)>>10, f=h&0x3FF;
      if(e===0) return s*Math.pow(2,-14)*(f/1024); if(e===31) return f?NaN:s*Infinity;
      return s*Math.pow(2,e-15)*(1+f/1024); };
    r.readRenderTargetPixels(rt, 0, 0, N, N, raw);
    let mx = 0, nan = 0, sum = 0, lit = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const g = half(raw[i+1]);
      if (Number.isNaN(g)) { nan++; continue; }
      const a = Math.abs(g);
      mx = Math.max(mx, a); sum += a; if (a > 0.002) lit++;
    }
    return { maxAbsHeight: +mx.toFixed(4), sumAbs: +sum.toFixed(1),
             litTexels: lit, nanTexels: nan, size: N };
  };
  const withOvertake = fieldMax();
  w.set('kelvin.overtake', 0);
  w.wake.update(w.state.t);   // the SIM clock in seconds, not wall ms
  const withoutOvertake = fieldMax();
  w.set('kelvin.overtake', 1);
  let ahead = null;
  try {
    const rt = wake.rt, r = w.renderer, N = 24;
    const raw = new Uint16Array(N*N*4);
    const half = (h) => { const s=(h&0x8000)?-1:1, e=(h&0x7C00)>>10, f=h&0x3FF;
      if(e===0) return s*Math.pow(2,-14)*(f/1024); if(e===31) return f?NaN:s*Infinity;
      return s*Math.pow(2,e-15)*(1+f/1024); };
    // The field is centred near the boat; sample the strip just forward of it.
    const cx = (rt.width - N) >> 1, cy = Math.min(rt.height - N, ((rt.height - N) >> 1) + 40);
    r.readRenderTargetPixels(rt, cx, cy, N, N, raw);
    let maxAbsH = 0, nz = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const g = half(raw[i+1]); if (Number.isNaN(g)) { nz = -1; break; }
      maxAbsH = Math.max(maxAbsH, Math.abs(g)); if (Math.abs(g) > 0.001) nz++;
    }
    ahead = { maxAbsHeight: +maxAbsH.toFixed(4), litTexels: nz, of: N*N };
  } catch (e) { ahead = { error: String(e).slice(0, 90) }; }
  return { cruising, stopped, withOvertake, withoutOvertake, ahead };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,2));
await browser.close(); server.close();
