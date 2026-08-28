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
  // Pull the throttle and let her run down.
  w.set('boat.speed', 0);
  for (let i = 0; i < 150; i++) w.stepSim(1/30);
  const stopped = snap('after a 5 s run-down');
  // And read the field itself: is there height AHEAD of the bow?
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
  return { cruising, stopped, ahead };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,2));
await browser.close(); server.close();
