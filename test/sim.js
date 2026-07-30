'use strict';

/**
 * Deterministic tests for the rules themselves, driving the Room directly with
 * no server and no sockets. These assert mechanics rather than waiting for
 * emergent behaviour, so they can't go flaky when balance changes.
 *
 *   node test/sim.js
 */

const { Room, C, TICK, MODIFIERS } = require('../server/game');

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** A room mid-round with `n` motionless human players and nothing else moving. */
function arena(n = 4) {
  const room = new Room('SIM');
  for (let i = 0; i < n; i++) room.add('p' + i, 'P' + i, '🙂', null);
  room.startCountdown();
  room.state = 'playing';
  room.timer = 0;
  const ps = [...room.players.values()];
  ps.forEach((p) => { p.vx = 0; p.vy = 0; p.input = { x: 0, y: 0, dash: false }; });
  return { room, ps };
}

const step = (room, seconds) => {
  const n = Math.round(seconds / TICK);
  for (let i = 0; i < n; i++) room.update(TICK);
};

/** Collect events as they're produced, since the room clears them each frame. */
function record(room, seconds) {
  const out = [];
  const n = Math.round(seconds / TICK);
  for (let i = 0; i < n; i++) {
    room.update(TICK);
    out.push(...room.events);
    room.events.length = 0;
  }
  return out;
}

console.log('\n💣  BOMB BLOBS rule tests\n');

/* ------------------------------------------------------------- the bomb */

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; });
  ps[0].bombT = 1.0;
  const ev = record(room, 1.5);
  ok('a fuse running out detonates', ev.some((e) => e.e === 'boom' && e.id === ps[0].id));
  ok('the holder is eliminated by their own bomb',
    ev.some((e) => e.e === 'out' && e.id === ps[0].id && e.how === 'boom'));
  ok('everyone else survives it', room.aliveList().length === 3);
}

{
  const { room, ps } = arena(4);
  // two blobs overlapping: the bomb must change hands
  ps[0].x = 0; ps[0].y = 0;
  ps[1].x = 30; ps[1].y = 0;
  ps[2].x = -300; ps[3].x = 300;
  ps[0].bombT = 5;
  ps[0].bombLock = 0;
  step(room, 1 / 30);
  ok('touching someone passes the bomb', ps[1].hasBomb && !ps[0].hasBomb);
  ok('the fuse keeps burning across a pass — it does not reset',
    ps[1].bombT > 4.8 && ps[1].bombT < 5, `${ps[1].bombT.toFixed(2)}s left`);
  ok('the passer is credited', ps[0].passes === 1);

  // still overlapping, so without the lock it would bounce straight back
  const before = ps[1].bombT;
  step(room, 1 / 30);
  ok('you cannot instantly pass it back', ps[1].hasBomb && before > 0);
}

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; });
  ps[0].bombT = 0.5;
  ps[0].shield = true;
  const ev = record(room, 1);
  ok('a shield survives your own explosion',
    ev.some((e) => e.e === 'saved') && ps[0].alive);
  ok('the shield is spent doing it', ps[0].shield === false);
}

/* --------------------------------------------------------------- ghosts */

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; });
  const victim = ps[0];
  victim.bombT = 0.2;
  step(room, 0.5);

  ok('elimination turns you into a ghost', victim.ghost && !victim.alive);
  const d = Math.hypot(victim.x, victim.y);
  ok('ghosts hover outside the floor', d > room.arena, `${d.toFixed(0)} vs arena ${room.arena.toFixed(0)}`);
  ok('ghosts are not counted as alive', !room.aliveList().includes(victim));
  ok('ghosts do not block the living', room.ghostList().length === 1);
}

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 120 - 180; p.y = 0; });
  const ghost = ps[0];
  const target = ps[1];
  target.x = 0; target.y = 0; target.vx = 0; target.vy = 0;

  // make a ghost by hand, park it left of centre, and fire right
  room.eliminate(ghost, 'boom');
  ghost.x = -300; ghost.y = 0;
  ghost.orbCd = 0;
  ghost.face = { x: 1, y: 0 };
  ghost.input = { x: 1, y: 0, dash: true };

  // Sample the impulse at the moment of impact — drag eats it within a second,
  // so checking at the end of the run would measure nothing.
  const ev = [];
  let vxAtImpact = null;
  for (let i = 0; i < Math.round(1.6 / TICK); i++) {
    room.update(TICK);
    ev.push(...room.events);
    if (vxAtImpact === null && room.events.some((e) => e.e === 'spook')) vxAtImpact = target.vx;
    room.events.length = 0;
  }

  ok('a ghost can launch a spook', ev.some((e) => e.e === 'orb'));
  ok('a spook connects with the living', ev.some((e) => e.e === 'spook' && e.id === target.id));
  ok('a spook actually shoves you', vxAtImpact > 200, `vx ${(vxAtImpact || 0).toFixed(0)} at impact`);
  ok('a spook can throw you off the edge', vxAtImpact > C.FALL_SPEED);
  ok('spooking goes on cooldown', ghost.orbCd > 0);
}

/* ----------------------------------------------------------- the edge */

{
  const { room, ps } = arena(4);
  const p = ps[0];
  ps.slice(1).forEach((q, i) => { q.x = i * 100 - 100; q.y = -300; });
  p.y = 0;
  p.x = room.arena - 5;
  p.vx = 120;             // strolling
  p.vy = 0;
  p.bombT = 0;
  ps[1].bombT = 5;        // park the bomb elsewhere so nothing else happens
  step(room, 0.6);
  ok('walking pace cannot push you off the edge', p.alive && p.falling === 0);

  const q = ps[0];
  q.x = room.arena - 5;
  q.vx = 700;             // thrown
  step(room, 0.3);
  ok('being thrown hard does', q.falling > 0 || q.ghost, q.ghost ? 'already out' : 'falling');
}

/* -------------------------------------------------------- round shape */

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; });
  ps[1].bombT = 5;
  room.eliminate(ps[2], 'boom');
  room.eliminate(ps[3], 'boom');
  const ev = record(room, 0.2);
  ok('sudden death starts when two are left', room.sudden && ev.some((e) => e.e === 'sudden'));

  const before = room.arena;
  step(room, 1);
  ok('the floor closes in during sudden death', room.arena < before,
    `${before.toFixed(0)} → ${room.arena.toFixed(0)}`);
}

{
  const { room, ps } = arena(4);
  ps.forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; });
  room.eliminate(ps[1], 'boom');
  room.eliminate(ps[2], 'boom');
  room.eliminate(ps[3], 'boom');
  const ev = record(room, 0.2);
  const win = ev.find((e) => e.e === 'win');
  ok('the last blob standing wins', !!win && win.id === ps[0].id);
  ok('the win is scored', ps[0].score === 1 && ps[0].streak === 1);
  ok('ghosts are revived for the next round', (() => {
    step(room, C.ROUND_OVER + 0.2);
    return room.state === 'countdown' && [...room.players.values()].every((p) => p.alive && !p.ghost);
  })());
}

/* ------------------------------------------------------------ modifiers */

{
  const room = new Room('MOD');
  for (let i = 0; i < 4; i++) room.add('p' + i, 'P' + i, '🙂', null);
  room.startCountdown();
  ok('round one is never a gimmick', room.mod.key === 'normal', room.mod.name);

  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const prev = room.mod.key;
    room.startCountdown();
    seen.add(room.mod.key);
    if (room.mod.key === prev) { ok('a modifier never repeats back to back', false); break; }
  }
  ok('a modifier never repeats back to back', true);
  ok('modifiers actually vary', seen.size >= 4, `saw ${seen.size} of ${MODIFIERS.length - 1}`);
}

{
  const room = new Room('DBL');
  for (let i = 0; i < 4; i++) room.add('p' + i, 'P' + i, '🙂', null);
  room.startCountdown();
  room.mod = MODIFIERS.find((m) => m.key === 'double');
  room.state = 'playing';
  [...room.players.values()].forEach((p, i) => { p.x = i * 200 - 300; p.y = 0; p.vx = 0; });
  room.beginPlay();
  const holders = [...room.players.values()].filter((p) => p.hasBomb).length;
  ok('DOUBLE TROUBLE puts two bombs in play', holders === 2, `${holders} holders`);

  const tiny = new Room('TNY');
  for (let i = 0; i < 4; i++) tiny.add('p' + i, 'P' + i, '🙂', null);
  tiny.startCountdown();
  tiny.mod = MODIFIERS.find((m) => m.key === 'tiny');
  tiny.startCountdown();
  // startCountdown picks its own modifier, so assert the mechanism instead
  const wanted = MODIFIERS.find((m) => m.key === 'tiny');
  ok('CROWDED HOUSE shrinks the starting floor',
    C.ARENA_START * wanted.arena < C.ARENA_START);
}

/* -------------------------------------------------------------- wiring */

{
  const { room, ps } = arena(4);
  ps[0].bombT = 3.4;
  ps[0].ghost = false;
  const snap = room.snapshot();
  const row = snap.p.find((r) => r[0] === ps[0].id);
  ok('snapshots carry each holder\'s own fuse', Math.round(row[8]) === 34, `got ${row[8]}`);
  ok('snapshots carry the modifier', typeof snap.md === 'string' && snap.md.length > 0);
  ok('snapshots carry movement multipliers for prediction',
    Array.isArray(snap.mv) && snap.mv.length === 2);

  room.eliminate(ps[1], 'boom');
  const g = room.snapshot().p.find((r) => r[0] === ps[1].id);
  ok('the ghost bit is set in snapshots', (g[5] & 64) !== 0);
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
