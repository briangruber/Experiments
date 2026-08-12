#!/usr/bin/env node
// End-to-end test: title card -> collect every spark on a world by walking the
// keeper onto each one -> world blooms -> beacon lights -> launch to the next
// world -> arrive. Exits non-zero if any step does not happen.
//
//   node tools/playthrough.mjs [--world 0]
//
// Runs at dt=0.05 — the game's own maximum frame clamp — so a whole six-second
// flight costs 124 frames instead of 372 under software rendering.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const WORLD = +opt('world', 0);
const PAGE = opt('page', 'index.html');   // e.g. dist/tiny-worlds.html

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? PAGE : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 520, height: 340 } });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' ')));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${server.address().port}/?world=${WORLD}&dt=0.05`, { waitUntil: 'load' });
await page.waitForFunction(() => window.tinyWorlds?.state.mode === 'title', null, { timeout: 90000 });

const frames = async (n) => {
  const start = await page.evaluate(() => window.tinyWorlds.state.frames);
  await page.waitForFunction((t) => window.tinyWorlds.state.frames >= t, start + n, { timeout: 180000 });
};

const steps = [];
const check = (name, pass, detail = '') => {
  steps.push({ name, pass, detail });
  console.log(`${pass ? ' ok ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// 1. The title card starts the game.
await page.click('#card-button');
await frames(3);
check('title card starts the game', await page.evaluate(() => window.tinyWorlds.state.mode === 'play'));

// 2. Walk onto every spark in turn. Each one must register.
const total = await page.evaluate(() => window.tinyWorlds.planets[window.tinyWorlds.state.worldIndex].moteTotal);
let collected = 0;
for (let i = 0; i < total; i++) {
  const got = await page.evaluate((idx) => {
    const tw = window.tinyWorlds;
    const p = tw.planets[tw.state.worldIndex];
    const m = p.motes[idx];
    tw.player.local.copy(m.obj.position);
    tw.player.vel.set(0, 0, 0);
    return tw.state.sparks;
  }, i);
  await frames(3);
  const now = await page.evaluate(() => window.tinyWorlds.state.sparks);
  if (now > got) collected++;
}
check('every spark can be collected', collected === total, `${collected}/${total}`);

// 3. Collecting the last one blooms the world and lights the beacon.
await frames(4);
const bloomed = await page.evaluate(() => {
  const tw = window.tinyWorlds;
  const p = tw.planets[tw.state.worldIndex];
  return { bloomed: p.bloomed, beacon: !!p.beaconOn, wave: p.waveRadius > 0 };
});
check('the world blooms', bloomed.bloomed && bloomed.wave, JSON.stringify(bloomed));
check('the beacon lights', bloomed.beacon);

// 4. Standing at the beacon offers the launch, and E takes it.
await page.evaluate(() => {
  const tw = window.tinyWorlds;
  const p = tw.planets[tw.state.worldIndex];
  tw.player.local.copy(p.beaconDir).multiplyScalar(p.groundRadius(p.beaconDir) + 0.1);
  tw.player.vel.set(0, 0, 0);
});
await frames(4);
check('the beacon offers the launch', await page.evaluate(() => window.tinyWorlds.state.promptAction === 'launch'));
await page.keyboard.press('KeyE');
await frames(3);
check('the launch starts', await page.evaluate(() => window.tinyWorlds.state.mode === 'flight'));

// 5. The flight lands on the next world.
const before = await page.evaluate(() => window.tinyWorlds.state.worldIndex);
await page.waitForFunction((i) => window.tinyWorlds.state.worldIndex > i || window.tinyWorlds.state.mode !== 'flight',
  before, { timeout: 300000 }).catch(() => {});
const after = await page.evaluate(() => ({ i: window.tinyWorlds.state.worldIndex, mode: window.tinyWorlds.state.mode, grounded: window.tinyWorlds.player.grounded }));
check('the flight lands on the next world', after.i === before + 1, JSON.stringify(after));

await browser.close();
server.close();

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = steps.filter((s) => !s.pass);
console.log(`\n${steps.length - failed.length}/${steps.length} passed`);
if (failed.length) process.exit(1);
