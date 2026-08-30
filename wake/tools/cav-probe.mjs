#!/usr/bin/env node
// Is there cavitation in the field, and WHERE along the wake is it?
//
// Turning every slider up and seeing nothing says the term is absent or in the
// wrong place, and a picture cannot tell those apart. This reads the baked
// field directly and reports where the bubble channel actually lights up
// relative to the boat, under load and at a steady cruise.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try { const u = decodeURIComponent(q.url.split('?')[0]);
    const f = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    r.end(await readFile(f)); } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs').catch(()=>import('playwright'));
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 260, height: 260 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=6&boat.speed=7`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 240000 }).catch(()=>{});
const out = await page.evaluate(async () => {
  const w = window.__wake, wake = w.wake;
  const half = (h) => { const s=(h&0x8000)?-1:1, e=(h&0x7C00)>>10, f=h&0x3FF;
    if(e===0) return s*Math.pow(2,-14)*(f/1024); if(e===31) return f?NaN:s*Infinity;
    return s*Math.pow(2,e-15)*(1+f/1024); };
  // The A channel is total bubble density; cavitation is added to it.
  const readField = () => {
    const rt = wake.rt, r = w.renderer, N = Math.min(rt.width, rt.height);
    const raw = new Uint16Array(N*N*4);
    r.readRenderTargetPixels(rt, 0, 0, N, N, raw);
    let maxA = 0, lit = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const a = half(raw[i+3]);
      if (Number.isNaN(a)) continue;
      maxA = Math.max(maxA, a); if (a > 0.02) lit++;
    }
    return { maxBubble: +maxA.toFixed(4), litTexels: lit, size: N };
  };
  const run = (cav) => {
    w.set('wash.cav', cav);
    w.wake.update(w.state.t);
    return readField();
  };
  // Under load: throttle well above the speed she is making.
  w.set('boat.speed', 18);
  for (let i = 0; i < 40; i++) w.stepSim(1/30);
  const loadNow = +(w.wake.path[0]?.load ?? -1).toFixed(3);
  const onLoad = run(3);
  const offLoad = run(0);
  // Steady: let her settle at the commanded speed, load should fall away.
  for (let i = 0; i < 400; i++) w.stepSim(1/30);
  const loadSteady = +(w.wake.path[0]?.load ?? -1).toFixed(3);
  const onSteady = run(3);
  w.set('wash.cav', 1.1);
  return { loadUnderThrottle: loadNow, loadAtSteadySpeed: loadSteady,
           underLoad_cavOn: onLoad, underLoad_cavOff: offLoad, steady_cavOn: onSteady,
           deltaLit: onLoad.litTexels - offLoad.litTexels };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,3));
await browser.close(); server.close();
