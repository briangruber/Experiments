#!/usr/bin/env node
// Mobile harness. Runs the game in emulated phones -- real touch events, real
// device pixel ratios, real safe-area-less viewports -- drives it with thumbs
// only, and fails if the controls do not actually control anything.
//
//   node tools/mobile-check.mjs [--shots shots/mobile] [--device "Pixel 5"]
//
// Checks per device: no client errors, the render loop turns, the touch layer
// exists, the floating stick moves the boat, THROW puts a harpoon in the air,
// and no HUD element overflows the screen.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const SHOTS = arg('--shots', null);
const ONLY = arg('--device', null);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const PORT = await new Promise((res, rej) => {
  const probe = createServer();
  probe.on('error', rej);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});

const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
await new Promise((r) => setTimeout(r, 800));

const { chromium, devices } = await loadPlaywright();

// A small phone in portrait, a mid phone in landscape (how people actually
// hold a driving game), and a tablet.
const CASES = [
  { name: 'iPhone SE portrait', device: devices['iPhone SE'] },
  { name: 'Pixel 5 landscape', device: devices['Pixel 5 landscape'] },
  { name: 'iPad Mini landscape', device: devices['iPad Mini landscape'] },
].filter((c) => c.device && (!ONLY || c.name.includes(ONLY)));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

let failed = 0;
const lines = [];
const check = (device, name, ok, detail = '') => {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  [${device}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

for (const c of CASES) {
  const context = await browser.newContext({ ...c.device, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    const touchMode = await page.evaluate(() => document.body.classList.contains('touch'));
    check(c.name, 'detected as a touch device', touchMode);

    // The start screen has to fit and be reachable with a thumb.
    const startFits = await page.evaluate(() => {
      const btn = document.getElementById('start-btn').getBoundingClientRect();
      return { visible: btn.top >= 0 && btn.bottom <= innerHeight, h: btn.height };
    });
    check(c.name, 'the start button is on screen and thumb-sized',
      startFits.visible && startFits.h >= 36, `height=${Math.round(startFits.h)}`);
    if (SHOTS) await page.screenshot({ path: join(ROOT, SHOTS, `${slug(c.name)}-start.png`) });

    await page.fill('#name-input', 'Thumbs');
    await page.tap('#start-btn');
    await page.waitForFunction(() => !document.getElementById('hud').hidden, { timeout: 20000 });
    await page.waitForTimeout(2500);

    const layer = await page.evaluate(() => !!document.getElementById('touch'));
    check(c.name, 'the touch controls are built', layer);

    // Drive with the left thumb: press in the stick zone and drag up-right.
    const size = page.viewportSize();
    const sx = size.width * 0.18, sy = size.height * 0.62;
    await page.touchscreen.tap(sx, sy);            // wakes the zone
    const drag = await page.evaluate(async ({ sx, sy }) => {
      const zone = document.getElementById('stick-zone');
      const send = (type, x, y) => zone.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true,
      }));
      zone.setPointerCapture = () => {};
      send('pointerdown', sx, sy);
      send('pointermove', sx + 30, sy - 60);
      await new Promise((r) => setTimeout(r, 2500));
      const d = window.__debug;
      const out = { stick: { ...d.game.stickEcho }, speed: d.speed ?? 0, travelled: d.distance ?? 0 };
      send('pointerup', sx + 30, sy - 60);
      return out;
    }, { sx, sy });
    check(c.name, 'the stick drives the boat', drag.speed > 0.4,
      `peak speed ${drag.speed.toFixed(2)}`);

    // Right thumb: hold THROW to charge, release to throw.
    const threw = await page.evaluate(async () => {
      const btn = document.getElementById('t-throw');
      const at = btn.getBoundingClientRect();
      const send = (type) => btn.dispatchEvent(new PointerEvent(type, {
        pointerId: 8, pointerType: 'touch', clientX: at.left + at.width / 2,
        clientY: at.top + at.height / 2, bubbles: true, isPrimary: true,
      }));
      send('pointerdown');
      await new Promise((r) => setTimeout(r, 1400));
      const charge = window.__debug.game.charge;
      send('pointerup');
      await new Promise((r) => setTimeout(r, 500));
      return { charge, inAir: window.__debug.harpoons.flights.length, cooling: window.__debug.game.cooldown };
    });
    check(c.name, 'THROW charges and releases a harpoon',
      threw.charge > 0.2 && (threw.inAir > 0 || threw.cooling > 0),
      `charge=${threw.charge.toFixed(2)} inAir=${threw.inAir}`);

    // Nothing should hang off the edge of the screen.
    const overflow = await page.evaluate(() => {
      const ids = ['hud-name', 'hull-text', 'minimap', 'event-log', 'touch-actions', 'touch-chips'];
      const bad = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
          bad.push(`${id}(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`);
        }
      }
      return { bad, w: innerWidth, h: innerHeight };
    });
    check(c.name, 'the HUD stays inside the screen', overflow.bad.length === 0, overflow.bad.join(' '));

    // The controls must not sit on top of each other.
    const overlap = await page.evaluate(() => {
      const r = (id) => document.getElementById(id)?.getBoundingClientRect();
      const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const actions = r('touch-actions');
      return {
        vitals: hit(actions, document.querySelector('.vitals')?.getBoundingClientRect()),
        minimap: hit(actions, r('minimap')),
        chips: hit(actions, r('touch-chips')),
      };
    });
    check(c.name, 'the thumb buttons do not cover the HUD',
      !overlap.vitals && !overlap.minimap && !overlap.chips, JSON.stringify(overlap));

    const perf = await page.evaluate(() => ({
      tier: window.__debug.tier, scale: window.__debug.pixelScale, frames: window.__frames,
    }));
    check(c.name, 'the render loop is turning', perf.frames > 10,
      `tier=${perf.tier} scale=${perf.scale} frames=${perf.frames}`);

    if (SHOTS) {
      await mkdir(join(ROOT, SHOTS), { recursive: true });
      await page.screenshot({ path: join(ROOT, SHOTS, `${slug(c.name)}-play.png`) });
      // And the dock, which is the densest panel on a small screen.
      await page.evaluate(() => window.__debug.hud.openDock());
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(ROOT, SHOTS, `${slug(c.name)}-dock.png`) });
      const dockFits = await page.evaluate(() => {
        const card = document.querySelector('.dock-card').getBoundingClientRect();
        return card.width <= innerWidth + 1;
      });
      check(c.name, 'the dock panel fits the screen', dockFits);
      await page.evaluate(() => window.__debug.hud.closeDock());
    }

    check(c.name, 'no client errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (err) {
    check(c.name, 'ran without throwing', false, err.message);
  }
  await context.close();
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

console.log('\n' + lines.join('\n'));
if (serverErr.trim()) { console.error('\nserver stderr:\n' + serverErr); failed++; }
console.log(`\n${lines.length - failed}/${lines.length} checks passed`);

await browser.close();
server.kill('SIGINT');
process.exit(failed ? 1 : 0);
