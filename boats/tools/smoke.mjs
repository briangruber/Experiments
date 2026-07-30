#!/usr/bin/env node
// Headless smoke test: boots the server, opens two players in one browser,
// sails them, throws harpoons, and fails on any console error or dead frame.
//
//   node tools/smoke.mjs [--shot out.png] [--seconds 12] [--headful]
//
// Exits non-zero if the client logged an error, the render loop stalled, or the
// second player never appeared in the first player's world.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 12));
const SHOT = arg('--shot', null);
const PORT = Number(arg('--port', 8791));

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

const done = (code) => { server.kill('SIGINT'); process.exit(code); };

await new Promise((r) => setTimeout(r, 700));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: !args.includes('--headful'),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

const errors = [];
async function openPlayer(name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.fill('#name-input', name);
  await page.click('#start-btn');
  await page.waitForFunction(() => !document.getElementById('hud').hidden, { timeout: 15000 });
  return page;
}

try {
  const a = await openPlayer('Ahab');
  const b = await openPlayer('Ishmael');

  // Both sail out of the harbour; Ahab throws harpoons at whatever he finds.
  for (const p of [a, b]) await p.keyboard.down('KeyW');
  await b.keyboard.down('KeyD');

  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    await a.mouse.down();
    await a.waitForTimeout(700);
    await a.mouse.up();
    await a.keyboard.down('KeyR');
    await a.waitForTimeout(500);
    await a.keyboard.up('KeyR');
    await a.mouse.move(640 + Math.random() * 200 - 100, 360);
  }
  for (const p of [a, b]) await p.keyboard.up('KeyW');

  // Drive the states a short sail never reaches by feeding the client the
  // server messages that cause them. This is the real client code path -- only
  // the sender is faked.
  const lifecycle = await a.evaluate(async () => {
    const d = window.__debug;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};

    const upgraded = {
      ...d.game.self, tier: 3, boat: 'whaler', hull: 560, hullMax: 560,
      crew: 8, crewMax: 8, gold: 4000, hold: 4,
      cargo: [{ id: 'silverfin', name: 'Silverfin Serpent', bounty: 95, slots: 1 },
              { id: 'gulper', name: 'Gulper Eel', bounty: 300, slots: 1 }],
    };
    d.net.emit('you', { t: 'you', ...upgraded });
    await wait(500);
    out.tierAfterBuy = d.game.boat.tier;
    out.towed = d.game.carcasses.length;

    d.hud.openDock();
    await wait(200);
    out.dockCards = document.querySelectorAll('#dock-boats .hull-card').length;
    d.hud.closeDock();

    d.net.emit('sank', {
      t: 'sank', by: 'Frost Leviathan', boat: 'Whaler', cargo: 2, gold: 1600,
      state: { ...upgraded, tier: 0, hull: 0, hullMax: 60, crew: 0, crewMax: 2, gold: 2400, cargo: [], hold: 1, dead: true },
    });
    await wait(500);
    out.deathShown = !document.getElementById('death').hidden;

    d.net.emit('respawn', {
      t: 'respawn', x: 0, z: 90,
      state: { ...upgraded, tier: 0, hull: 60, hullMax: 60, crew: 2, crewMax: 2, gold: 2400, cargo: [], hold: 1, dead: false },
    });
    await wait(500);
    out.deathHidden = document.getElementById('death').hidden;
    out.tierAfterSink = d.game.boat.tier;
    out.towedAfterSink = d.game.carcasses.length;
    return out;
  });
  await a.waitForTimeout(500);

  const report = await a.evaluate(() => ({
    frames: window.__frames || 0,
    monsters: window.__debug?.monsters ?? -1,
    players: window.__debug?.players ?? -1,
    distance: window.__debug?.distance ?? 0,
    speed: window.__debug?.speed ?? 0,
    fps: window.__debug?.fps ?? 0,
  }));
  report.lifecycle = lifecycle;

  if (SHOT) {
    await mkdir(dirname(resolve(ROOT, SHOT)), { recursive: true });
    await a.screenshot({ path: resolve(ROOT, SHOT) });
  }

  console.log(JSON.stringify({ ...report, errors }, null, 2));

  let bad = false;
  if (errors.length) { console.error('\nclient errors:\n' + errors.join('\n')); bad = true; }
  // Headless chromium renders this scene through swiftshader at a few frames a
  // second, so this is a "did the loop keep turning" check, not a perf budget.
  if (report.frames < SECONDS * 2) { console.error(`\nrender stalled: only ${report.frames} frames`); bad = true; }
  if (report.players < 1) { console.error('\nthe other player never appeared'); bad = true; }
  // Distance is a poor check here: swiftshader runs at a few frames a second
  // and the loop clamps dt, so the simulation advances in slow motion. Whether
  // the throttle did anything is the real question.
  if (report.speed < 0.5 || report.distance <= 0) {
    console.error(`\nthe throttle did nothing: speed=${report.speed}, travelled=${report.distance}`);
    bad = true;
  }
  const L = report.lifecycle;
  const expect = (ok, msg) => { if (!ok) { console.error(`\n${msg}`); bad = true; } };
  expect(L.tierAfterBuy === 3, 'buying a hull did not swap the boat');
  expect(L.towed === 2, `expected 2 carcasses under tow, saw ${L.towed}`);
  expect(L.dockCards === 7, `shipwright listed ${L.dockCards} hulls, expected 7`);
  expect(L.deathShown, 'sinking did not show the death screen');
  expect(L.deathHidden, 'respawning did not clear the death screen');
  expect(L.tierAfterSink === 0, `respawn left the player in tier ${L.tierAfterSink}`);
  expect(L.towedAfterSink === 0, 'the hold was not emptied by sinking');
  if (serverErr.trim()) { console.error('\nserver stderr:\n' + serverErr); bad = true; }

  await browser.close();
  done(bad ? 1 : 0);
} catch (err) {
  console.error(err);
  console.error(errors.join('\n'));
  await browser.close().catch(() => {});
  done(1);
}
