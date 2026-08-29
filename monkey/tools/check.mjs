#!/usr/bin/env node
// Play the room to the end, in a headless browser, by clicking real pixels.
//
//   node tools/check.mjs
//   node tools/check.mjs --shot shots/dock.png
//
// This is the check that matters. It does not assert on internals: it walks
// the same four-step chain a player walks — take the hook, knock down the cup,
// fill it, bribe Grout, board the ship — through the verb coin and the
// inventory and the dialogue menu, and fails if any of it stops working.
//
// Exits non-zero on any page error, so it doubles as a smoke test for the
// renderer. The completion assertion is what makes it a game test.

import { resolve } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SHOT = opt('shot', null);
// The same playthrough, against the single-file bundle instead of the served
// folder. A bundle that loads but cannot be finished is worse than no bundle.
const PAGE = args.includes('--bundle') ? 'dist/monkey.html' : 'index.html';

const { port: PORT, close: closeServer } = await serve();

const browser = await launch();
// The bundle puts the canvas in a column under a header, so it needs a taller
// window than the bare index.html to keep the whole board clickable.
const page = await browser.newPage({ viewport: { width: 1280, height: PAGE === 'index.html' ? 780 : 1040 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// The plate probe 404s until tools/plate.mjs has been run, which is the
// normal state of the repo. Everything else on the error channel is real.
// Both 404 until the generating tools have been run, which is the normal state
// of a fresh clone. The font request fails only in sandboxes without egress;
// the published page loads it fine.
const EXPECTED_404 = /dock-plate\.png|voice\/manifest\.json|favicon\.ico|fonts\.googleapis\.com/;
page.on('response', (r) => {
  if (r.status() === 404 && !EXPECTED_404.test(r.url())) errors.push('404: ' + r.url());
});
page.on('console', (m) => {
  if (m.type() === 'error') { if (!EXPECTED_404.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); }
  else if (m.text().startsWith('[')) console.log('  ' + m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/${PAGE}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__monkey);

// --- driving the game -------------------------------------------------------

// Every click below goes through the browser's real mouse at real client
// coordinates, computed from the room's own data. Nothing calls a game
// function directly, so the input path is under test too.
await page.evaluate(() => {
  const M = window.__monkey;
  window.__t = {
    rect: () => document.getElementById('stage').getBoundingClientRect(),
    // room space -> client space, through the camera and the canvas scale
    toClient(rx, ry, worldSpace = true) {
      const r = this.rect();
      const sx = worldSpace ? rx - M.room().camX : rx;
      return { x: r.left + (sx / 1280) * r.width, y: r.top + (ry / 720) * r.height };
    },
    spot(id) {
      const h = M.room().hotspots.find((s) => s.id === id);
      if (!h) throw new Error('no hotspot ' + id);
      return { x: h.rect[0] + h.rect[2] / 2, y: h.rect[1] + h.rect[3] / 2 };
    },
    grout() { const a = M.actors.grout; return { x: a.x, y: a.y - 90 }; },
    // A bare click-to-walk does not go through the sequencer, so "the
    // sequencer is empty" is not "the game has finished moving". Leaving the
    // walk out of this made the camera-scrolling loop below fire eight clicks
    // in a row without ever waiting for the first one.
    settled: () => !M.seq.busy && M.actors.player.state !== 'walk'
      && !M.actors.player.line && !M.actors.grout.line,
    idle: () => window.__t.settled() && !M.menu.active,
    // "Nothing is playing" is not the same as "nothing is waiting for me":
    // a conversation ends with the menu open and the sequencer empty.
    quiet: () => window.__t.settled(),
    coinOpen: () => M.coin.open,
    coinAt: () => ({ x: M.coin.x, y: M.coin.y }),
    camX: () => M.room().camX,
    menuOpen: () => M.menu.active,
    menuOptions: () => (M.menu.options || []).map((o) => o.text),
    inv: () => [...M.state.inventory],
    invSlot(item) {
      const i = M.state.inventory.indexOf(item);
      if (i < 0) throw new Error('not held: ' + item);
      return { x: 8 + i * 68 + 30, y: 720 - 76 - 8 + 38 };
    },
    selected: () => M.inv.selected,
    flag: (k) => M.state.get(k),
    playerAt: () => ({ x: Math.round(M.actors.player.x), y: Math.round(M.actors.player.y) }),
    // A patch of floor that is on screen, walkable, under no hotspot and not
    // behind the inventory strip — i.e. somewhere a click means "walk here".
    freeFloor(preferLeft) {
      const room = M.room(), cam = room.camX;
      for (const y of [700, 690, 712, 676]) {
        for (const sx of (preferLeft ? [110, 150, 200, 260] : [1170, 1130, 1080, 1020])) {
          const rx = sx + cam;
          if (!room.walk.walkable(rx, y)) continue;
          if (room.hotspotAt(rx, y)) continue;
          if (M.inv.contains(sx, y, M.state.inventory)) continue;
          return { x: sx, y };
        }
      }
      return null;
    },
  };
});

const T = (fn, ...a) => page.evaluate(fn, ...a);
const click = async (pt, worldSpace = true) => {
  const c = await page.evaluate(([p, w]) => window.__t.toClient(p.x, p.y, w), [pt, worldSpace]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
};
const idle = () => page.waitForFunction(() => window.__t.idle(), null, { timeout: 20000 });
const quiet = () => page.waitForFunction(() => window.__t.quiet(), null, { timeout: 20000 });

// The camera eases toward the player rather than snapping, so a click computed
// from room coordinates in one evaluate and delivered a few milliseconds later
// can land tens of pixels off. Every click waits for the camera to stop first.
// (A real player never notices this; a script clicking single pixels does.)
async function settle() {
  await idle();
  await page.waitForFunction(() => {
    const x = window.__t.camX();
    const was = window.__camWas;
    window.__camWas = x;
    return was !== undefined && Math.abs(x - was) < 0.05;
  }, null, { timeout: 8000, polling: 60 });
}

// Nothing off screen can be clicked, by a script or by a player. Walking the
// camera onto the target first is not test scaffolding — it is the same thing
// a player does, and making the check do it keeps the check honest about what
// the interface actually allows.
async function ensureVisible(pt) {
  for (let i = 0; i < 8; i++) {
    await settle();
    const sx = await T((p) => p.x - window.__t.camX(), pt);
    if (sx > 90 && sx < 1190) return;
    const dest = await T((left) => window.__t.freeFloor(left), sx <= 90);
    if (process.env.DEBUG) console.log(`    [vis] sx=${Math.round(sx)} dest=${JSON.stringify(dest)} cam=${Math.round(await T(() => window.__t.camX()))} player=${JSON.stringify(await T(() => window.__t.playerAt()))}`);
    if (!dest) throw new Error('nowhere to walk toward ' + JSON.stringify(pt));
    await click(dest, false);
    await idle();
  }
  throw new Error('could not bring ' + JSON.stringify(pt) + ' on screen');
}

// The verb coin lays its three icons at fixed angles 46px from the click.
const VERB_OFFSET = { look: [0, -46], use: [39.8, 23], talk: [-39.8, 23] };
async function verb(spotPt, which) {
  await ensureVisible(spotPt);
  await click(spotPt);
  await page.waitForFunction(() => window.__t.coinOpen(), null, { timeout: 4000 });
  // The icon position comes from where the coin actually opened, not from a
  // second projection of the hotspot — those two can disagree.
  const [dx, dy] = VERB_OFFSET[which];
  const c = await page.evaluate(([d]) => {
    const at = window.__t.coinAt();
    const s = window.__t.toClient(at.x + d[0], at.y + d[1], false);
    return s;
  }, [[dx, dy]]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await quiet();
}

async function useItemOn(item, spotPt) {
  await ensureVisible(spotPt);
  await click(await T((i) => window.__t.invSlot(i), item), false);
  const sel = await T(() => window.__t.selected());
  if (sel !== item) throw new Error(`could not select ${item} (selected: ${sel})`);
  await click(spotPt);
  await idle();
}

async function pickDialogue(match) {
  await page.waitForFunction(() => window.__t.menuOpen(), null, { timeout: 10000 });
  const opts = await T(() => window.__t.menuOptions());
  const i = opts.findIndex((t) => t.toLowerCase().includes(match.toLowerCase()));
  if (i < 0) throw new Error(`no dialogue option matching "${match}" in ${JSON.stringify(opts)}`);
  const y = 720 - 34 - (opts.length - 1 - i) * 34;
  await click({ x: 140, y }, false);
}

// --- the playthrough --------------------------------------------------------

const steps = [];
const step = async (name, fn, assert) => {
  await fn();
  const ok = await T(assert);
  steps.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) throw new Error('step failed: ' + name);
};

try {
  await idle();

  // A bundle that quietly falls back to placeholder art looks fine and is
  // wrong. This caught exactly that: the bundled loadPlate was still fetching
  // a path that does not exist inside a single file.
  await step('the generated art and voice are actually in use', async () => {}, () => {
    const M = window.__monkey;
    return M.usingPlate() && M.voiced;
  });

  await step('walk to a clicked point on the floor', async () => {
    await click({ x: 700, y: 690 });
    await idle();
  }, () => window.__t.playerAt().y > 600);

  await step('take the boat hook from the nets  [use]', async () => {
    await verb(await T(() => window.__t.spot('nets')), 'use');
  }, () => window.__t.inv().includes('boathook'));

  await step('knock the cup off the wall  [boathook -> cup]', async () => {
    await useItemOn('boathook', await T(() => window.__t.spot('cup')));
  }, () => window.__t.inv().includes('cup'));

  await step('fill the cup at the barrel  [cup -> barrel]', async () => {
    await useItemOn('cup', await T(() => window.__t.spot('barrel')));
  }, () => window.__t.inv().includes('cup-of-grog') && !window.__t.inv().includes('cup'));

  await step('the pier is still shut', async () => {}, () => !window.__t.flag('pier-open'));

  await step('talk Grout into a drink  [dialogue tree]', async () => {
    await verb(await T(() => window.__t.grout()), 'talk');
    // The tree re-opens itself after each exchange, so the second choice is
    // made from the menu the first one left behind.
    await pickDialogue('board that ship');
    await quiet();
    await pickDialogue('perhaps this would help');
    await idle();
  }, () => window.__t.flag('grout-asleep') && window.__t.flag('pier-open'));

  // Captured before boarding, because the win overlay covers the room and a
  // screenshot of the room is the point.
  if (SHOT) {
    await ensureVisible({ x: 700, y: 690 });
    await page.mouse.move(600, 300);
    await page.locator('#stage').screenshot({ path: resolve(ROOT, SHOT) });
    console.log(`  shot -> ${SHOT}`);
  }

  await step('board the ship past the opened pier  [pathfinding into new floor]', async () => {
    await verb(await T(() => window.__t.spot('ship')), 'use');
  }, () => window.__t.flag('aboard'));
} catch (e) {
  errors.push(e.message);
}

await browser.close();
closeServer();

console.log('');
if (errors.length) {
  console.error('FAILED\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`completed the room: ${steps.length}/${steps.length} steps, no page errors`);
