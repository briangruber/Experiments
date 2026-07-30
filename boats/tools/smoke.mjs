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

const village = {};

try {
  const a = await openPlayer('Ahab');
  const b = await openPlayer('Ishmael');

  // You start ashore, on the dock. Walk a few paces first.
  village.startedAshore = await a.evaluate(() => window.__debug.game.mode);
  const before = await a.evaluate(() => ({ ...window.__debug.avatar.pos }));
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(1500);
  // Sampled while the key is still down: swiftshader runs the sim in slow
  // motion, so "how far did it get" is meaningless here but "is it walking" is
  // not.
  village.walkSpeed = await a.evaluate(() => window.__debug.avatar.speed);
  await a.keyboard.up('KeyW');
  village.walked = await a.evaluate((p0) => {
    const p = window.__debug.avatar.pos;
    return Math.hypot(p.x - p0.x, p.z - p0.z);
  }, before);

  // Fish off the end of the pier. The waiting is scripted so the test does not
  // sit around for a bite, but every transition is the real state machine.
  village.fishing = await a.evaluate(async () => {
    const d = window.__debug;
    const f = d.fishing;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const spot = d.town.places.fishing;
    d.avatar.pos.set(spot.x, spot.y, spot.z);
    d.avatar.heading = 0;
    f.beginCast();
    f.charge = 1;
    const tip = d.avatar.rodTip();
    f.releaseCast(tip, { x: 0, y: 0, z: 1 });   // straight off the end of the pier
    // Fly the float by hand: the render loop drives it, so just wait for it.
    for (let i = 0; i < 40 && f.phase === 'fly'; i++) await wait(50);
    out.landed = f.phase;
    // Skip the waiting and the teasing.
    for (let i = 0; i < 60 && f.phase !== 'bite'; i++) { f.timer = 0; await wait(40); }
    out.reachedBite = f.phase === 'bite';
    out.species = f.fish?.species?.id;
    f.strike();
    out.hooked = f.phase === 'fight';
    return out;
  });

  // Play the fish: hold the reel, but let go when it runs. This is the actual
  // skill of the mini-game, expressed as a bot.
  village.fought = await a.evaluate(async () => {
    const f = window.__debug.fishing;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let caught = false;
    const stop = window.__debug.fishing.hooks;
    const prevCatch = stop.onCatch;
    stop.onCatch = (c) => { caught = c; prevCatch?.(c); };
    for (let i = 0; i < 400 && f.fighting; i++) {
      // Back off on a run or when the rod is loaded up; otherwise wind.
      window.__debug.input.reeling = !(f.running || f.tension > 0.8);
      await wait(30);
    }
    stop.onCatch = prevCatch;
    window.__debug.input.reeling = false;
    return { caught: !!caught, kg: caught ? +caught.kg.toFixed(2) : 0, phase: f.phase };
  });

  // Walk to the mooring and board. (Placed rather than pathed: the interaction
  // is what is under test, not the walking, which was checked above.)
  await a.evaluate(() => {
    const d = window.__debug;
    const s = d.town.places.step;
    d.avatar.pos.set(s.x, s.y, s.z);
  });
  await a.waitForTimeout(400);
  await a.keyboard.press('KeyE');
  await a.waitForTimeout(500);
  village.boarded = await a.evaluate(() => window.__debug.game.mode);

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
  report.village = village;

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
  const V = report.village;
  const expect = (ok, msg) => { if (!ok) { console.error(`\n${msg}`); bad = true; } };
  expect(V.startedAshore === 'shore', `the game did not start ashore (mode=${V.startedAshore})`);
  expect(V.walkSpeed > 1, `walking never got going (${(V.walkSpeed || 0).toFixed(2)} m/s)`);
  expect(V.walked > 0.05, 'the avatar did not move at all');
  expect(V.fishing?.landed === 'wait', `the cast did not settle (phase=${V.fishing?.landed})`);
  expect(V.fishing?.reachedBite, 'no bite ever came');
  expect(V.fishing?.hooked, 'striking on the bite did not hook the fish');
  expect(V.fought?.caught, `the fish was never landed (ended ${V.fought?.phase})`);
  expect(V.boarded === 'sail', `pressing E at the mooring did not board (mode=${V.boarded})`);
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
