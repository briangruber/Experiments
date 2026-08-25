#!/usr/bin/env node
// Headless capture. Serves the folder, loads the page, lets the wake build for
// a while, screenshots, and fails loudly on any console/page error so it works
// as a smoke test too.
//
//   node tools/shot.mjs --out shots/a.png --wait 12 --set arms.angle=18
//   node tools/shot.mjs --out shots/turn.png --set boat.turnRate=6 --cam -1.1,0.4,70

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const multi = (n) => argv.reduce((a, v, i) => (v === '--' + n ? [...a, argv[i + 1]] : a), []);

const OUT = resolve(ROOT, opt('out', 'shots/frame.png'));
const WAIT = +opt('wait', 3);           // seconds to let the page settle before the shot
const W = +opt('w', 1100), H = +opt('h', 1100);
const CAM = opt('cam', '');
const PREWARM = opt('prewarm', '90');   // seconds of boat run before the first frame

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
                   '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const qs = new URLSearchParams();
for (const s of multi('set')) { const [k, v] = s.split('='); qs.set(k, v); }
if (CAM) qs.set('cam', CAM);
qs.set('prewarm', PREWARM);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '?' + qs.toString(), { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(WAIT * 1000);
if (argv.includes('--field')) await page.keyboard.press('f');
// Guarded: when the module fails to load there is no __wake, and the useful
// output is the error that caused it -- not a crash inside the probe.
const diag = await page.evaluate(() => {
  const w = window.__wake;
  if (!w) return { loaded: false };
  return { pathPts: w.wake.path.length, maxArc: +(w.wake.maxArc || 0).toFixed(1),
           travelled: +Math.hypot(w.state.x, w.state.z).toFixed(1),
           extent: w.wake.extent, drawn: w.wake.geometry.drawRange.count };
});
await page.evaluate(() => document.body.classList.add('hide-ui'));
await page.waitForTimeout(300);

await mkdir(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
await browser.close();
server.close();

console.log(JSON.stringify({ out: OUT, diag, errors }, null, 2));
if (errors.length) process.exit(1);
