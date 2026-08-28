#!/usr/bin/env node
// Is there bubble churn behind the engines at slow speed?
// The field's A channel is bubble density, B the surfaced fraction of it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const f = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    r.end(await readFile(f));
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const loadPw = async () => { for (const c of ['playwright','/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean))
  { try { return await import(c); } catch {} } throw new Error('no playwright'); };
const { chromium } = await loadPw();
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 220 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=20&boat.speed=1.4`, { waitUntil: 'load' });
await page.waitForFunction('window.__wake && window.__wake.wake', { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const w = window.__wake, wake = w.wake;
  const read = () => {
    const rt = wake.rt, r = w.renderer, N = Math.min(rt.width, rt.height);
    const raw = new Uint16Array(N*N*4);
    const half = (h) => { const s=(h&0x8000)?-1:1, e=(h&0x7C00)>>10, f=h&0x3FF;
      if(e===0) return s*Math.pow(2,-14)*(f/1024); if(e===31) return f?NaN:s*Infinity;
      return s*Math.pow(2,e-15)*(1+f/1024); };
    r.readRenderTargetPixels(rt, 0, 0, N, N, raw);
    let maxDens = 0, sumDens = 0, lit = 0, maxSurf = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const surf = half(raw[i+2]), dens = half(raw[i+3]);
      if (Number.isNaN(dens)) continue;
      maxDens = Math.max(maxDens, dens); sumDens += dens;
      maxSurf = Math.max(maxSurf, surf);
      if (dens > 0.002) lit++;
    }
    return { maxDensity: +maxDens.toFixed(4), sumDensity: +sumDens.toFixed(1),
             litTexels: lit, maxSurfaced: +maxSurf.toFixed(4) };
  };
  const run = (speed, idle) => {
    w.set('boat.speed', speed); w.set('wash.idle', idle);
    for (let i = 0; i < 120; i++) w.stepSim(1/30);
    wake.update(w.state.t);
    return { speed, idle, ...read() };
  };
  return { slowWithIdle: run(1.4, 0.55), slowNoIdle: run(1.4, 0),
           cruise: run(7, 0.55) };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,2));
await browser.close(); server.close();
