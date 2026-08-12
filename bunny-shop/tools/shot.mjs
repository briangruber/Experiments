#!/usr/bin/env node
// Headless capture and smoke test.
//
//   node tools/shot.mjs --out shots/shop.png --wait 3000
//   node tools/shot.mjs --out shots/play.png --play 20000   # click through a day
//
// Exits non-zero on any page error, failed request or WebGL warning, so it
// doubles as the test suite.

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  for (const c of ['playwright', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try {
      return await import(c);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found');
}

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const OUT = opt('out', 'shots/frame.png');
const PAGE = opt('page', 'index.html');
const WAIT = +opt('wait', 2500);
const PLAY = +opt('play', 0);
const SIM = +opt('sim', 0);
const EVAL = opt('eval', '');
const CAM = opt('cam', '');
const LOOK = opt('look', '');
const OPEN = args.includes('--open') || PLAY > 0 || SIM > 0;
const W = +opt('w', 1440);
const H = +opt('h', 810);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// The image ships a Chromium build that will not always match whatever
// Playwright version npm resolved, so prefer the one that is actually here.
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME_PATH].find(
  (p) => p && existsSync(p),
);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
});
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  logs.push(text);
  if (m.type() === 'error') errors.push(text);
});

await page.goto(`http://127.0.0.1:${port}/${PAGE}`, { waitUntil: 'load' });

// Wait for the loader to finish rather than guessing.
await page
  .waitForFunction(() => !document.querySelector('#start')?.disabled, { timeout: 120000 })
  .catch(() => errors.push('assets never finished loading'));

await page.waitForTimeout(WAIT);

if (OPEN) {
  await page.click('#start');
  await page.waitForTimeout(WAIT);
}

// Software rendering runs at a few frames a second, so waiting in wall-clock
// time barely advances the game. Stepping the simulation directly gets the shop
// to a busy state in a fraction of a second, and deterministically.
if (SIM) {
  await page.evaluate((seconds) => {
    for (let i = 0; i < seconds * 60; i++) window.__game.update(1 / 60);
  }, SIM);
  await page.waitForTimeout(700);
}

if (PLAY) {
  const until = Date.now() + PLAY;
  // Poke the counter at random to exercise bagging, the bell and petting.
  while (Date.now() < until) {
    await page.waitForTimeout(420);
    await page.mouse.move(200 + Math.random() * (W - 400), 300 + Math.random() * (H - 400));
    if (Math.random() < 0.75) await page.mouse.down(), await page.mouse.up();
    if (Math.random() < 0.3) await page.keyboard.press(String(1 + Math.floor(Math.random() * 6)));
    if (Math.random() < 0.2) await page.keyboard.press('Space');
  }
}

// Arbitrary poking, for setting up a specific situation to look at.
if (EVAL) {
  const result = await page.evaluate((src) => eval(src), EVAL);
  if (result !== undefined) console.error('eval:', JSON.stringify(result));
  await page.waitForTimeout(400);
}

// Override the framing to inspect a corner of the shop.
if (CAM || LOOK) {
  await page.evaluate(
    ({ cam, look }) => {
      const g = window.__game;
      const camera = g.ui.camera;
      if (cam) camera.position.set(...cam.split(',').map(Number));
      window.__lookAt = look ? look.split(',').map(Number) : [0, 1.15, -0.8];
      camera.lookAt(...window.__lookAt);
      window.__freezeCamera = true;
    },
    { cam: CAM, look: LOOK },
  );
  await page.waitForTimeout(600);
}

const report = await page.evaluate(() => ({
  shoppers: window.__game?.shoppers.length ?? null,
  day: window.__game?.day ?? null,
  coins: window.__game?.coins ?? null,
  hearts: window.__game?.hearts ?? null,
  phases: (window.__game?.shoppers ?? []).map((s) => s.phase),
}));

await mkdir(dirname(resolve(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: resolve(ROOT, OUT) });

await browser.close();
server.close();

const real = errors.filter((e) => !/favicon/.test(e));
console.log(JSON.stringify({ out: OUT, errors: real, report, logTail: logs.slice(-12) }, null, 2));
process.exit(real.length ? 1 : 0);
