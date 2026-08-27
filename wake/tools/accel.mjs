#!/usr/bin/env node
// Start from rest, open the throttle, and watch the wake arrive.
//
// Two things must hold. The wake has to BUILD -- foam coverage rising over
// seconds, not appearing whole on the first frame. And it must be world-locked:
// the tail end of the wake stays where the boat started, so its distance behind
// the boat grows at roughly the boat's speed rather than sitting at a fixed
// offset (which is what "stuck to the boat" would look like).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try { const u = decodeURIComponent(q.url.split('?')[0]);
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    r.end(await readFile(p)); } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));

// prewarm 0: start genuinely from rest, with no history.
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=0&cam=-1.5708,0,120&boat.speed=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 90000 }).catch(() => {});
await page.evaluate(() => document.body.classList.add('hide-ui'));
await page.waitForTimeout(1200);

// Sim time is stepped explicitly; dt is clamped per frame and this renderer is slow.
const step = async (sec) => {
  await page.evaluate((d) => {
    const w = window.__wake;
    const n = Math.ceil(d / 0.033);
    for (let i = 0; i < n; i++) w.stepSim(0.033);
  }, sec);
  await page.waitForTimeout(700);
};

const sample = async (label) => {
  const shot = await page.screenshot({ timeout: 180000 });
  const st = await page.evaluate(() => {
    const w = window.__wake;
    return { speed: +w.state.speed.toFixed(2), maxArc: +(w.wake.maxArc || 0).toFixed(1),
             travelled: +Math.hypot(w.state.x, w.state.z).toFixed(1) };
  });
  return { label, ...st, shot: shot.toString('base64') };
};

const frames = [];
frames.push(await sample('t=0 (rest)'));
await page.evaluate(() => window.__wake.set('boat.speed', 13));
let elapsed = 0;
for (const t of [2, 4, 8, 16]) {
  await step(t - elapsed);          // step the DIFFERENCE, so labels are real times
  elapsed = t;
  frames.push(await sample(`+${t}s`));
}

const probe = await browser.newPage();
for (const f of frames) {
  f.foam = await probe.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i]+d[i+1]+d[i+2])/3 > 120) lit++;
    return +(lit / (d.length / 4)).toFixed(4);
  }, f.shot);
  delete f.shot;
}
await probe.close();

console.log(JSON.stringify(frames, null, 2));
await browser.close(); server.close();
if (errs.length) { console.error(errs); process.exit(1); }
