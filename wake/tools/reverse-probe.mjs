#!/usr/bin/env node
// Two claims, measured: the boat goes ASTERN, and nothing steers her off a
// heading she was given near the shore.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
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
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__wake', { timeout: 180000 });
const out = await page.evaluate(() => {
  const w = window.__wake, st = w.state;
  const run = (secs) => { for (let i = 0; i < secs * 30; i++) w.stepSim(1 / 30); };
  const at = () => ({ x: +st.x.toFixed(1), z: +st.z.toFixed(1), spd: +st.speed.toFixed(2) });
  // 1. astern from rest, on the slider alone.
  st.x = 0; st.z = 0; st.speed = 0; st.heading = 0; st.course = 0;
  w.set('boat.speed', -4); w.set('boat.turnRate', 0);
  run(8);
  const astern = at();
  // Which way did she go relative to her own bow? heading 0 => bow along +Z.
  const asternAlongBow = +(st.z).toFixed(1);

  // 2. drive at the beach on a fixed heading and see whether the helm is taken
  //    from us. Aim straight out at the coast from the middle of the lagoon.
  const shore = w.shore;
  const coast = shore ? shore.coastAt(0) : 0;
  st.x = 0; st.z = coast * 0.35; st.speed = 0; st.heading = 0; st.course = 0;
  w.set('boat.speed', 9);
  const h0 = st.heading;
  run(20);
  const beach = { ...at(), coast: +coast.toFixed(0),
                  headingDrift: +((st.heading - h0) * 180 / Math.PI).toFixed(2),
                  bed: +(shore ? shore.heightAt(st.x, st.z) : NaN).toFixed(2) };
  return { astern, asternAlongBow, beach };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,3));
await browser.close(); server.close();
