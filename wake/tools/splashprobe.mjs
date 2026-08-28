#!/usr/bin/env node
// Why is the rock spray not firing? Ask the page instead of reading the source.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (q, r) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    r.end(await readFile(p));
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
// Same resolution dance as shot.mjs: playwright is not resolvable by bare
// specifier in this environment.
const loadPw = async () => {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                   '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
};
const { chromium } = await loadPw();
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/?prewarm=15&shore.spray=3`, { waitUntil: 'load' });
await page.waitForFunction('window.__wake && window.__wake.shore', { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(6000);
const out = await page.evaluate(() => {
  const w = window.__wake; if (!w) return { loaded: false };
  const sh = w.shore, sea = w.sea, cam = w.camera;
  const sites = sh?.splashSites ?? null;
  const t = sea?.water?.ocean?.time;
  const S = Math.max(w.get('foamMix.surfSpan'), 0.25), T = Math.max(w.get('foamMix.surfPeriod'), 0.5);
  let inRange = 0, hot = 0, minD = 1e9;
  const range = w.get('shore.sprayRange');
  for (const s of sites ?? []) {
    const d = Math.hypot(s.x - cam.position.x, s.z - cam.position.z);
    minD = Math.min(minD, d);
    if (d <= range) { inRange++;
      const env = 0.5 + 0.5*Math.sin((s.column/S + (t||0)/T) * Math.PI*2);
      if (env >= 0.88) hot++; }
  }
  return { sites: sites?.length ?? null, oceanTime: t, timeIsNumber: typeof t,
           sprayParam: w.get('shore.spray'), range, inRange, hot,
           nearestSiteDist: Math.round(minD), sprayLive: w.spray?.n,
           camY: Math.round(cam.position.y), boulders: sh?.boulderCount };
});
console.log(JSON.stringify(out, null, 2)); if (errs.length) console.log('ERRORS', errs.slice(0,3));
await browser.close(); server.close();
