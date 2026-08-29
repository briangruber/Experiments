#!/usr/bin/env node
// Where does the frame go?
//
// Ablation, not a profiler: switch one thing off, measure, switch it back.
// Absolute milliseconds here are software-rasteriser numbers and mean nothing
// on a real GPU -- but this shader is ALU-bound in both, so the ORDERING of
// the deltas is worth having, and a term that costs nothing when switched off
// is doing nothing for the picture either way.
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
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const CAM = opt('cam', '1.40,0.3,420');   // the wide top-down the report came from
const W = +opt('w', 300), H = +opt('h', 300);
const { chromium } = await loadPw();
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=20&boat.speed=6&boat.turnRate=4&cam=${CAM}`,
  { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 240000 }).catch(()=>{});
const out = await page.evaluate(async () => {
  const w = window.__wake;
  // Time the DRAW, and force the pipe to drain before stopping the clock --
  // GL commands are queued, so timing render() alone times the queueing.
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const measure = async (n) => {
    const ts = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await frame();
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    return +ts[ts.length >> 1].toFixed(1);   // median, so one hitch cannot decide it
  };
  await measure(6);                            // warm
  const base = await measure(14);
  const rows = [];
  // Each entry: a label and the params to null out. Restored after every run.
  const CASES = [
    ['bed caustics',        { 'lake.caustics': 0 }],
    ['coral heads',         { 'lake.coral': 0 }],
    ['screen refraction',   { 'scene.refraction': 0 }],
    ['wake field bake',     { 'field.trailLength': 1 }],
    ['kelvin interference', { 'kelvin.interfere': 0 }],
    ['shore + terrain',     { 'shore.on': 0 }],
    ['sea whitecaps',       { 'foamMix.seaWhitecaps': 0 }],
  ];
  for (const [label, sets] of CASES) {
    const old = {};
    let ok = true;
    for (const k of Object.keys(sets)) {
      try { old[k] = w.get(k); w.set(k, sets[k]); } catch { ok = false; }
    }
    if (!ok) { rows.push({ label, err: 'no such param' }); continue; }
    await measure(4);
    const t = await measure(14);
    for (const k of Object.keys(old)) w.set(k, old[k]);
    rows.push({ label, ms: t, savedMs: +(base - t).toFixed(1),
                savedPct: +(100 * (base - t) / base).toFixed(1) });
  }
  await measure(4);
  const after = await measure(10);
  rows.sort((a, b) => (b.savedMs ?? -1) - (a.savedMs ?? -1));
  return { baseMs: base, recheckMs: after, camDist: w.camera.position.length().toFixed(0), rows };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,3));
await browser.close(); server.close();
