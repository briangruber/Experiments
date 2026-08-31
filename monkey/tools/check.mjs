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
const EXPECTED_404 = /scene\.(mp4|png)|voice\/manifest\.json|favicon\.ico|fonts\.googleapis\.com/;
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
    scrolls: () => M.room().width > M.room().view.w,
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
  // A room no wider than the view has no camera, so nothing can be off screen
  // and the margins below would reject perfectly clickable edges.
  if (await T(() => window.__t.scrolls() === false)) { await settle(); return; }
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
  // A backdrop that has quietly fallen back to the still — or to nothing —
  // looks almost right and is not what shipped. Name which one is live.
  await step('the generated backdrop and voice are in use, and both actors draw', async () => {}, () => {
    const M = window.__monkey;
    // Both of them are atlas bodies now — the whole cast is generated pixel
    // art bound through SPRITE_CAST, and the procedural puppets are the
    // fallback rather than the other half of the room. Naming the exact counts
    // rather than checking "something drew" is what catches an atlas that
    // silently failed to bind and let the puppet stand in, which looks nearly
    // right and is not what shipped.
    // Bound is not drawn. An atlas body that renders nothing satisfies every
    // count here and shipped exactly that way — the player was simply absent
    // from the room while bodies() said 1. drawn() hides the actor, repaints
    // and diffs the box it claims to occupy, which no null renderer passes.
    return (M.backdrop() === 'video' || M.backdrop() === 'still') && M.voiced
      && M.bodies() === 2 && M.puppets() === 0 && M.pixelBlock() > 1
      && M.drawn('player') > 40 && M.drawn('grout') > 40;
  });

  // Legs that cycle four times a second under a walk is a fault no playthrough
  // notices and every player does. A human walks a bit over one stride per
  // second; anything past two is a sprint played at walking pace.
  await step('the walk cycles at a human cadence', async () => {}, () => {
    const c = window.__monkey.cadence('player');
    window.__t.cadence = c;
    return c >= 0.7 && c <= 2.0;
  });

  // The characters were shipped once at a third of the resolution their own
  // art is drawn on, because the grid they were matched to was read off a
  // retired constant instead of measured off the plate. Both figures now draw
  // at twice their sheet height, which is the backdrop's own 2px block, and
  // this is the assertion that says so — near the front of the room, where
  // they spend the game and where the depth scale is ~1.
  await step('the cast is drawn on the backdrop\'s pixel grid', async () => {}, () => {
    const M = window.__monkey;
    const px = { player: M.artPixel('player'), grout: M.artPixel('grout') };
    window.__t.artPixel = px;
    // Depth pulls this down toward the back of the room, which is depth doing
    // its job; what must not happen is a character whose art pixel is smaller
    // than the scene's anywhere near the camera.
    return px.player >= 1.7 && px.player <= 2.3 && px.grout >= 1.7 && px.grout <= 2.3;
  });

  // Feet that stay where they were put.
  //
  // Two separate faults lived here. Horizontally, the atlas pinned every
  // frame's head to one column — right for a walk, wrong for a character
  // standing still whose head sways, which slid the whole body and gave Grout
  // a shuffle. Vertically, it pinned each frame's LOWEST pixel, and background
  // removal leaves specks: a single stray pixel in one frame was pinned level
  // with an eleven-pixel boot toe in the next, so his boots sat three rows
  // lower for most of the loop and hopped up for the rest.
  //
  // Both are measured on the canvas, stepping each clip by hand so the answer
  // is the same every run, and the walk is measured by the same call and must
  // come out LARGE — a drift measure that read zero everywhere would pass the
  // still-clip assertions while proving nothing.
  await step('still clips keep their feet still  [and the walk does not]', async () => {}, () => {
    const M = window.__monkey;
    const d = {
      groutIdle: M.footTrack('grout', 'idle'),
      groutDrink: M.footTrack('grout', 'drink'),
      playerIdle: M.footTrack('player', 'idle'),
      groutWalk: M.footTrack('grout', 'walk'),
    };
    window.__t.footTrack = d;
    const still = (t) => t.x >= 0 && t.x <= 2 && t.y >= 0 && t.y <= 2;
    return still(d.groutIdle) && still(d.groutDrink) && still(d.playerIdle)
      && d.groutWalk.x > 8;
  });

  // Double-clicking the floor runs.
  //
  // Driven through the real mouse, because the first version of this step
  // called walkTo directly and so proved only that the plumbing worked — it
  // could not have caught a double-click that never reached the actor, which
  // is exactly what was reported. Pace is sampled over a fixed interval rather
  // than timed to arrival, which would depend on where the walk had got to.
  await step('double-click runs  [through the mouse, 2x the pace]', async () => {
    // A destination that is floor and is not Grout. `freeFloor` only avoids
    // declared hotspots; the harbourmaster is an actor with his own hit box,
    // and he stands at the left end of the dock — so the first version of this
    // clicked him, opened the verb coin and measured a pace of zero.
    const target = (left) => T((l) => {
      const M = window.__monkey, room = M.room(), g = M.actors.grout;
      for (const y of [700, 690, 712]) {
        for (const sx of (l ? [420, 460, 500, 540] : [1170, 1130, 1080])) {
          const rx = sx + room.camX;
          if (!room.walk.walkable(rx, y)) continue;
          if (room.hotspotAt(rx, y)) continue;
          // Clear of the harbourmaster's hit box, which is about 60px either side.
          if (Math.abs(rx - g.x) < 160) continue;
          return { x: sx, y };
        }
      }
      return null;
    }, left);

    const [from, to] = [await target(false), await target(true)];
    if (!from || !to) throw new Error('no clear floor to cross');

    // Both trials run the identical route from the identical start, so the
    // only difference between them is the second click.
    const paceOf = async (double) => {
      await page.evaluate(() => { window.__monkey.seq.cancel(); window.__monkey.actors.player.stop(); });
      await click(from, false);
      await idle();
      await click(to, false);
      if (double) { await page.waitForTimeout(110); await click(to, false); }
      await page.waitForFunction(() => window.__monkey.actors.player.state === 'walk', null, { timeout: 4000 });
      const a = await T(() => window.__monkey.actors.player.x);
      await page.waitForTimeout(400);
      const b = await T(() => ({ x: window.__monkey.actors.player.x, running: window.__monkey.actors.player.running }));
      await page.evaluate(() => window.__monkey.actors.player.stop());
      return { pace: Math.round(Math.abs(a - b.x) / 0.4), running: b.running };
    };
    const walked = await paceOf(false);
    const ran = await paceOf(true);
    // These run in node; the assertion below runs in the page, so the results
    // have to be handed across rather than assigned to a `window` that does
    // not exist out here.
    await page.evaluate((v) => { window.__t.walked = v.walked; window.__t.ran = v.ran; }, { walked, ran });
    await idle();
  }, () => {
    const w = window.__t.walked, r = window.__t.ran;
    return !w.running && r.running && r.pace > w.pace * 2
      && window.__monkey.cadence('player', 'run') > window.__monkey.cadence('player', 'walk');
  });

  // An actor must never hold a facing its art cannot draw.
  //
  // The room asks for `facing: 'back'` at eight hotspots along the rear wall —
  // the barrel, the cup, the sign, the lantern, the door, the window, the
  // crates, the nets — and the whole cast is side-view only, because every
  // prompt sent to AutoSprite says so and the service has no direction
  // parameter. The actor was holding 'back', the renderer was ignoring it and
  // drawing a profile, and nothing anywhere noticed the two disagreed. Now the
  // turn resolves to the profile pointing at the thing being used.
  await step('nobody faces a direction their art has not got', async () => {
    await page.evaluate(() => { window.__t.faced = []; });
    for (const id of ['barrel', 'crates', 'nets']) {
      await verb(await T((h) => window.__t.spot(h), id), 'look');
      await idle();
      await page.evaluate((h) => {
        const M = window.__monkey, p = M.actors.player;
        const spot = M.room().hotspots.find((s) => s.id === h);
        window.__t.faced.push({ id: h, facing: p.facing, x: Math.round(p.x),
          cx: Math.round(spot.rect[0] + spot.rect[2] / 2) });
      }, id);
    }
  }, () => {
    const M = window.__monkey;
    return window.__t.faced.length === 3 && window.__t.faced.every((f) =>
      // A facing the body can draw...
      M.actors.player.body.facings.has(f.facing)
      // ...and the one that points at what is being used.
      && f.facing === (f.cx > f.x ? 'right' : 'left'));
  });

  // A character that changes size in a jump as it walks upstage is a fault the
  // playthrough cannot see and the player cannot miss. Sample the depth range
  // and require the change to be gradual.
  await step('the character scales smoothly with depth', async () => {}, () => {
    const M = window.__monkey;
    let worst = 0, prev = null;
    for (let y = 530; y <= 710; y += 20) {
      const h = M.spriteHeightAt('player', y);
      if (prev !== null) worst = Math.max(worst, Math.abs(h - prev));
      prev = h;
    }
    window.__t.scaleStep = worst;
    return worst > 0 && worst <= 14;
  });

  await step('walk to a clicked point on the floor', async () => {
    await click({ x: 700, y: 690 });
    await idle();
  }, () => window.__t.playerAt().y > 600);

  await step('take the boat hook from the nets  [use]', async () => {
    await verb(await T(() => window.__t.spot('nets')), 'use');
  }, () => window.__t.inv().includes('boathook'));

  // The cup is the one prop generated by AutoSprite rather than repainted from
  // a vector blockout, and it is loaded from a file with a procedural
  // fallback — so "the sprite is on disk" and "the sprite is on screen" are
  // different claims, and only the second one matters.
  await step('the generated cup is on the wall  [prop sprite draws]', async () => {}, () => {
    const M = window.__monkey;
    const d = M.propDrawn('cup');
    const size = M.propSize('cup');
    window.__t.cupDrawn = d;
    window.__t.cupSize = size;
    // Pixels in the box AND the generated sprite's own 64x64 cell. Without the
    // second half, the procedural cup that stands in for a missing file passes
    // this step exactly as well as the generated one.
    return d > 120 && size && size.w === 64 && size.h === 64;
  });

  await step('knock the cup off the wall  [boathook -> cup]', async () => {
    await useItemOn('boathook', await T(() => window.__t.spot('cup')));
  }, () => window.__t.inv().includes('cup'));

  await step('fill the cup at the barrel  [cup -> barrel]', async () => {
    await useItemOn('cup', await T(() => window.__t.spot('barrel')));
  }, () => window.__t.inv().includes('cup-of-grog') && !window.__t.inv().includes('cup'));

  await step('the pier is still shut', async () => {}, () => !window.__t.flag('pier-open'));

  await step('talk Grout into a drink  [dialogue tree]', async () => {
    await page.evaluate(() => { window.__t.stoodBox = window.__monkey.poseBox('grout'); });
    await verb(await T(() => window.__t.grout()), 'talk');
    // The tree re-opens itself after each exchange, so the second choice is
    // made from the menu the first one left behind.
    await pickDialogue('board that ship');
    await quiet();
    await pickDialogue('perhaps this would help');
    await idle();
  }, () => window.__t.flag('grout-asleep') && window.__t.flag('pier-open'));

  // He used to be deleted at this moment — `visible = false`, a placeholder for
  // art that did not exist. Now he sits down and sleeps there, and the flag
  // being set is not evidence that he does: a clip that failed to load, or a
  // manifest without an `asleep` entry, leaves a man standing to attention
  // beside an open pier and passes every assertion above.
  //
  // So this asks the picture. He must still put pixels on the canvas, and his
  // silhouette must have become a sleeping one — shorter than he stood and
  // wider than he was.
  await step('Grout is drawn asleep, not deleted  [pose]', async () => {}, () => {
    const M = window.__monkey;
    const b = M.poseBox('grout');
    window.__t.pose = b;
    if (!b || b.clip !== 'asleep') return false;
    const stood = window.__t.stoodBox;
    return M.drawn('grout') > 40 && b.h < stood.h * 0.75 && b.w > stood.w * 1.2;
  });

  // Captured before boarding, because the win overlay covers the room and a
  // screenshot of the room is the point.
  if (SHOT) {
    await ensureVisible({ x: 700, y: 690 });
    await page.mouse.move(600, 300);
    await page.locator('#stage').screenshot({ path: resolve(ROOT, SHOT) });
    console.log(`  shot -> ${SHOT}`);
  }

  await step('leave down the jetty Grout was blocking  [pathfinding into new floor]', async () => {
    await verb(await T(() => window.__t.spot('jetty')), 'use');
  }, () => window.__t.flag('aboard'));
} catch (e) {
  errors.push(e.message);
}

// The measurements the steps were judged on, read out while the page is still
// alive and printed at the end. A step that says "ok" and nothing else is a
// step nobody can sanity-check.
const m = errors.length ? {} : await page.evaluate(() => ({
  cadence: window.__t.cadence, runCadence: window.__monkey.cadence('player', 'run'),
  walked: window.__t.walked, ran: window.__t.ran, artPixel: window.__t.artPixel,
  footTrack: window.__t.footTrack, scaleStep: window.__t.scaleStep, pose: window.__t.pose,
  cupDrawn: window.__t.cupDrawn, cupSize: window.__t.cupSize,
}));

await browser.close();
closeServer();

console.log('');
if (errors.length) {
  console.error('FAILED\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`measured: art pixel player ${m.artPixel?.player}, grout ${m.artPixel?.grout}`);
console.log(`          walk ${m.cadence} strides/s at ${m.walked?.pace}px/s;`
  + ` run ${m.runCadence} strides/s at ${m.ran?.pace}px/s`);
console.log(`          foot drift x/y: grout idle ${m.footTrack?.groutIdle?.x}/${m.footTrack?.groutIdle?.y}px,`
  + ` player idle ${m.footTrack?.playerIdle?.x}/${m.footTrack?.playerIdle?.y}px,`
  + ` grout walk ${m.footTrack?.groutWalk?.x}/${m.footTrack?.groutWalk?.y}px`);
console.log(`          depth step ${m.scaleStep}px; asleep box ${m.pose?.w}x${m.pose?.h};`
  + ` cup ${m.cupDrawn}px of a ${m.cupSize?.w}x${m.cupSize?.h} sprite\n`);
console.log(`completed the room: ${steps.length}/${steps.length} steps, no page errors`);
