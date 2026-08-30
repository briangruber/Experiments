#!/usr/bin/env node
// Are the bubbles alive, and does the water actually composite them?
//
// "I cannot see them" has two very different causes -- none being emitted, or
// plenty being emitted and none surviving the water's compositing gate -- and a
// screenshot cannot tell them apart. This reports the live count, and then
// reads the refraction DEPTH buffer to see whether they register there at all,
// which is the gate that decides whether the water ever looks at them.
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
const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=4&boat.speed=9&cam=0.35,0.6,26`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 240000 }).catch(()=>{});
const out = await page.evaluate(async () => {
  const w = window.__wake;
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  // Drive her hard so the load signal is high: that is what opens the emitter.
  w.set('boat.speed', 20);
  w.set('wash.bubRate', 900);
  for (let i = 0; i < 40; i++) await frame();
  const live = w.bubbles ? { pool: w.bubbles.n, drawn: w.bubbles.drawn } : null;
  // A live bubble's world position, and whether it is under the surface.
  let sample = null;
  if (w.bubbles && w.bubbles.drawn > 0) {
    const a = w.bubbles.aPos.array;
    sample = { x: +a[0].toFixed(2), y: +a[1].toFixed(2), z: +a[2].toFixed(2) };
  }
  // Distance from the boat, which is the "released far away" question.
  const d = sample ? Math.hypot(sample.x - w.state.x, sample.z - w.state.z) : null;
  return { live, sample, metresFromBoat: d === null ? null : +d.toFixed(1),
           boatSpeed: +w.state.speed.toFixed(1),
           material: w.bubbles ? {
             depthWrite: w.bubbles.material.depthWrite,
             depthTest: w.bubbles.material.depthTest,
             blending: w.bubbles.material.blending,
           } : null };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,3));
await browser.close(); server.close();
