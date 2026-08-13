#!/usr/bin/env node
// Determinism guard for the multiplayer seam.
//
//   node tools/determinism.mjs [--ticks 4000] [--seed 5]
//
// Runs the same seed and the same events twice: once with the simulation
// stepped cleanly, once with rendering hammered at wildly varying frame rates
// in between. A shared coop is only possible if those two runs produce
// bit-identical worlds — if rendering can nudge the simulation at all, two
// viewers on the same seed drift apart and the whole plan fails.
//
// It also checks that a snapshot round-trips, since that is how a late joiner
// arrives mid-scene and how drift gets corrected.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const TICKS = +opt('ticks', 4000);
const SEED = opt('seed', '5');

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* try next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

// The scripted session both runs replay: a few player actions at fixed ticks.
const SCRIPT = [
  { at: 120, type: 'seeds', payload: { x: 1.2, z: -0.4 } },
  { at: 400, type: 'poke', payload: { chicken: 2 } },
  { at: 900, type: 'bulb', payload: {} },
  { at: 1500, type: 'seeds', payload: { x: -2.0, z: 2.1 } },
  { at: 2200, type: 'poke', payload: { chicken: 7 } },  // Bertha
  { at: 3000, type: 'seeds', payload: { x: 0.4, z: 0.9 } },
  // The outdoor dynamics are shared state too, so they belong in the guard.
  { at: 1800, type: 'door', payload: { open: false } },
  { at: 2400, type: 'door', payload: { open: true } },
  { at: 2700, type: 'worm', payload: { x: 1.6, z: 9.2 } },
  { at: 3400, type: 'hawk', payload: {} },
  { at: 3900, type: 'seeds', payload: { x: -1.5, z: 8.4 } },
];

// Deep fingerprint of everything the simulation owns. Full precision: the
// point is to catch a divergence of one ulp before it becomes a chicken
// walking the other way.
const FINGERPRINT = `(() => {
  const w = window.chickenGame.world;
  const num = (v) => (Object.is(v, -0) ? 0 : v);
  return JSON.stringify({
    tick: w.tick,
    time: w.time,
    door: w.door.open,
    dayT: num(w.dayT), phase: w.phase,
    chicks: w.chicks.map((k) => [k.active ? 1 : 0, k.slot,
      k.mum ? w.chickens.indexOf(k.mum) : -1, k.crossing ? 1 : 0]),
    hawk: [w.hawk.active, num(w.hawk.t)],
    worm: w.worm ? [num(w.worm.pos.x), num(w.worm.pos.z), w.worm.taken, num(w.worm.age ?? 0)] : 0,
    watchers: w.watchers.map((x) => [x.id, num(x.pos.x), num(x.pos.y), num(x.pos.z)]),
    eggs: w.eggs.map((e) => [e.userData.id, e.position.x, e.position.z,
      e.userData.golden, e.userData.vel.x, e.userData.vel.z]),
    chickens: w.chickens.map((c) => [
      num(c.pos.x), num(c.pos.y), num(c.pos.z), num(c.yaw), c.zone, c.active ? 1 : 0,
      c.bhv.name, num(c.bhv.t), num(c.bhv.dur),
      num(c.gait), num(c.gaitAmp), num(c.sit), num(c.sitT), num(c.flap), num(c.flapT),
      num(c.fall), num(c.fallT), num(c.lid), num(c.lidT), num(c.legTuck),
      num(c.bodyRoll), num(c.peckT), num(c.neckPitch), num(c.headYaw), num(c.headTilt),
      c.perch ? 1 : 0, c.riding ? 1 : 0, c.riders.length, c.frozen ? 1 : 0,
      c.hop ? [num(c.hop.t), num(c.hop.dur), num(c.hop.height)] : 0,
      c.move ? [num(c.move.target.x), num(c.move.target.z), num(c.move.speed)] : 0,
      Object.entries(c.cooldowns).sort().map(([k, v]) => k + ':' + num(v)).join(','),
    ]),
  });
})()`;

async function run(label, jitterRender) {
  const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?seed=${SEED}&paused=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.chickenGame, null, { timeout: 20000 });

  const state = await page.evaluate(async ([ticks, script, jitter, fpSrc]) => {
    const g = window.chickenGame;
    // Already paused via ?paused=1, so tick 0 really is tick 0.
    // mulberry32 again, seeded differently from the world, so the render
    // jitter pattern is reproducible but unrelated to the simulation.
    let s = 0x1234567 >>> 0;
    const chaos = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const trace = [];
    const byTick = new Map(script.map((e) => [e.at, e]));
    for (let i = 0; i < ticks; i++) {
      const ev = byTick.get(g.world.tick);
      if (ev) g.send(ev.type, ev.payload);
      g.step(1);
      // Light per-tick trace so a divergence can be located, not guessed at.
      if (i % 5 === 0) {
        let acc = i + '|';
        for (const c of g.world.chickens) acc += c.bhv.name + ',' + c.bhv.t.toFixed(4) + ';';
        trace.push(acc);
      }
      if (jitter && chaos() < 0.25) {
        // Draw at a delta anywhere from 240 Hz to 4 Hz, at a random point
        // between ticks. Software rasterisation is slow, so this fires on a
        // quarter of ticks — still hundreds of frames at wildly mixed rates,
        // which is what exercises the effect pools that used to leak.
        g.renderFrame(0.004 + chaos() * 0.25, chaos());
      }
    }
    return { fp: eval(fpSrc), snap: g.snapshot(), trace };
  }, [TICKS, SCRIPT, jitterRender, FINGERPRINT]);

  await page.close();
  return { label, ...state, errors };
}

const clean = await run('clean ticks', false);
const jittered = await run('ticks + chaotic rendering', true);

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const match = clean.fp === jittered.fp;

// Snapshot round-trip: apply a snapshot to a fresh world and confirm the
// chickens land where the snapshot said they were.
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const snapErrors = [];
page.on('pageerror', (e) => snapErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/?seed=9999&paused=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.chickenGame, null, { timeout: 20000 });
const roundTrip = await page.evaluate((snap) => {
  const g = window.chickenGame;
  g.paused = true;
  g.applySnapshot(snap);
  const after = g.snapshot();
  // Transforms must round-trip exactly. Behaviors needing a partner or a
  // target are deliberately replaced with wander on restore, so those are
  // counted rather than treated as failures.
  const diffs = [];
  let substituted = 0;
  snap.chickens.forEach((row, i) => {
    const got = after.chickens[i];
    if (!got) { diffs.push({ i, want: row, got: null }); return; }
    for (let f = 0; f < 4; f++) {
      if (row[f] !== got[f]) diffs.push({ i, field: f, want: row[f], got: got[f] });
    }
    if (row[4] !== got[4]) substituted++;
  });
  return {
    same: diffs.length === 0 && after.tick === snap.tick,
    diffs: diffs.slice(0, 4), substituted,
    bytes: JSON.stringify(snap).length, chickens: after.chickens.length,
  };
}, clean.snap);
await page.close();

await browser.close();
server.close();

const report = {
  ok: match && roundTrip.same && !clean.errors.length && !jittered.errors.length && !snapErrors.length,
  ticks: TICKS,
  seed: SEED,
  events: SCRIPT.length,
  cleanHash: hash(clean.fp),
  jitteredHash: hash(jittered.fp),
  identical: match,
  snapshotRoundTrip: roundTrip.same,
  snapshotDiffs: roundTrip.diffs,
  snapshotBehaviorsSubstituted: roundTrip.substituted,
  snapshotBytes: roundTrip.bytes,
  errors: [...clean.errors, ...jittered.errors, ...snapErrors].slice(0, 8),
};
console.log(JSON.stringify(report, null, 2));

if (!report.ok) {
  if (!match) {
    // Where did they part company?
    const a = clean.trace, b = jittered.trace;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error(`\nfirst diverging sample (tick ${i * 5}):\n  clean:    ${a[i]}\n  jittered: ${b[i]}`);
        if (i > 0) console.error(`  previous sample matched: ${a[i - 1]}`);
        break;
      }
    }
  }
  if (!match) {
    // Point at the first field that differs, so a regression is debuggable.
    const a = JSON.parse(clean.fp), b = JSON.parse(jittered.fp);
    for (let i = 0; i < a.chickens.length; i++) {
      const x = JSON.stringify(a.chickens[i]), y = JSON.stringify(b.chickens[i]);
      if (x !== y) { console.error(`\nfirst divergence, chicken ${i}:\n  clean:    ${x}\n  jittered: ${y}`); break; }
    }
    console.error('\nRendering is leaking into the simulation. See the rules in src/net.js.');
  }
  process.exit(1);
}
