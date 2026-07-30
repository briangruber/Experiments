#!/usr/bin/env node
// Model viewer. Spawns every monster (or every hull) in a line on the real
// ocean and screenshots them, so the body plans can be judged without playing
// to level 22 first.
//
//   node tools/bestiary.mjs --out shots/bestiary.png
//   node tools/bestiary.mjs --boats --out shots/fleet.png
//   node tools/bestiary.mjs --only frost --out shots/frost.png

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('--port', 8801));
const OUT = arg('--out', 'shots/bestiary.png');
const ONLY = arg('--only', null);
const BOATS = args.includes('--boats');
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.fill('#name-input', 'Shipwright');
await page.click('#start-btn');
await page.waitForFunction(() => !document.getElementById('hud').hidden, { timeout: 20000 });
await page.waitForTimeout(1500);

const info = await page.evaluate(async ({ only, boats }) => {
  const THREE = await import('/vendor/three.module.min.js');
  const { MonsterView } = await import('/src/monster.js');
  const { createBoat } = await import('/src/boat.js');
  const { MONSTERS, BOATS: HULLS } = await import('/shared/config.js');
  const d = window.__debug;
  const g = d.game;

  // Cut the server loose first: otherwise the next snapshot deletes every
  // monster we are about to place, since the server has never heard of them.
  d.net.scheduleReconnect = () => {};
  d.net.ws.close();
  for (const v of g.monsters.values()) { d.scene.remove(v.root); }
  g.monsters.clear();

  const list = boats ? HULLS : MONSTERS.filter((m) => !only || m.id === only);
  const built = [];
  let cursor = 0;
  const spacing = [];
  for (const item of list) spacing.push(boats ? item.length * 1.5 + 12 : item.size * 10 + 14);
  const total = spacing.reduce((a, b) => a + b, 0);
  cursor = -total / 2;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const x = cursor + spacing[i] / 2;
    cursor += spacing[i];
    if (boats) {
      const b = createBoat(i);
      b.group.position.set(x, b.floatY, 600);
      b.group.rotation.y = -0.6;
      d.scene.add(b.group);
      built.push({ name: item.name, x });
    } else {
      const v = new MonsterView(item.id, 9000 + i);
      v.x = v.tx = x; v.z = v.tz = 600; v.h = v.th = -0.5; v.sp = item.speed;
      v.state = 1;
      d.scene.add(v.root);
      g.monsters.set(9000 + i, v);
      built.push({ name: item.name, x, size: item.size });
    }
  }

  // Rather than fight the chase camera, moor the player's own boat in front of
  // the line-up and let the normal rig frame it -- the hull doubles as a scale
  // reference.
  const span = Math.max(60, total);
  g.boat.x = 0;
  g.boat.z = 600 + span * 0.58;
  g.boat.h = -Math.PI / 2;
  g.boat.speed = 0;
  d.game.time = 4;
  const cam = d.cam;
  if (cam) { cam.dist = 2.4; cam.pitch = 0.10; cam.yaw = 0; }
  return { count: built.length, names: built.map((b) => b.name), span };
}, { only: ONLY, boats: BOATS });

console.log(JSON.stringify(info));

await page.waitForTimeout(3000);
await mkdir(dirname(resolve(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: resolve(ROOT, OUT) });
console.log('wrote', resolve(ROOT, OUT));

await browser.close();
server.kill('SIGINT');
process.exit(0);
