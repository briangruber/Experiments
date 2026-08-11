// The pod.
//
// Three dolphins that notice a boat cruising gently and come and porpoise
// alongside for a minute, then peel away. This is the reward for going SLOW:
// they only join between a lazy putter and a brisk cruise, never during the
// fishing beat, never in the shallows, and never while you are flat out with
// Shift held — the lagoon gives you something for pottering that it withholds
// from hurrying.
//
// They are not new geometry. wildlife.createActors('dolphin', 3) builds them
// from the same creature kit as every fish in the bay — same material, same
// swim-bend attribute, zero new pipelines — and this module just drives the
// pool the way the fishing minigame drives its quarry. The waterline clip is
// already on the actor mesh, so an arc through the surface trims itself and
// the reflection pass picks up the airborne half for free.
//
// The porpoising is PARAMETRIC, not simulated: each animal follows a moving
// slot beside the boat (ahead_i, side_i) with its own phase in a vertical
// sine. Chasing the slot through a spring gives the lag and overshoot that
// read as swimming; the sine gives clean arcs whose entries and exits land
// where wakeFoam.burst can stamp hand-drawn splashes. A real steering sim was
// tried in the head and rejected on paper: it would spend its whole budget
// re-deriving "stay beside the boat and undulate", badly.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

const POD = 3;

// When the pod is willing to join. The speed window is the whole design:
// below it you are drifting (they lose interest), above it you are hurrying
// (they cannot be bothered). Depth keeps them out of the reef flats where an
// arc would put their belly in the coral.
const JOIN_SPEED = [1.6, 8.0];
const JOIN_DEPTH = 3.2;
const AWAY_TIME = [18, 42];        // seconds parked between visits
const ESCORT_TIME = [40, 75];      // seconds they stay
const JOIN_DIST = 26;              // spawn this far out, converge from there

// The arc. Cycle ~2.6 s at cruise, crest ~0.6 m out of the water, trough
// ~1.4 m under — a shallow, relaxed porpoise, not a show jump.
const DIVE_Y = -1.35;
const CREST_Y = 0.62;

export function createDolphins(opts = {}) {
  const { wildlife, terrain } = opts;
  const water = opts.water || (() => null);
  const burst = opts.burst || null;         // wakeFoam.burst(x, z, n, strength)
  const rng = makeRng(0xD0F1);

  const pool = wildlife && typeof wildlife.createActors === 'function'
    ? wildlife.createActors('dolphin', POD)
    : null;

  // Per-animal state. Positions are world; phase is the porpoise sine.
  const pod = [];
  for (let i = 0; i < POD; i++) {
    pod.push({
      x: 0, z: 0, y: -2,
      vx: 0, vz: 0,
      yaw: 0, pitch: 0,
      phase: rng.range(0, TAU),
      beat: rng.range(0, TAU),
      // The slot: how far ahead of the transom and how far out from the hull
      // this animal holds station. Staggered so the pod is an echelon, not a
      // row — and the signs alternate so they bracket the boat.
      ahead: 2.5 + i * 2.1,
      side: (i % 2 === 0 ? 1 : -1) * (3.0 + i * 0.7),
      wasAbove: false,
    });
  }

  let mode = 'away';                 // away | join | escort | leave
  let timer = rng.range(6, 14);      // first visit comes reasonably soon
  let joinT = 0;

  const surfaceAt = (x, z, t) => (water?.()?.sampleHeight ? water().sampleHeight(x, z, t) : 0);
  const depthAt = (x, z) => (terrain?.depthAt ? terrain.depthAt(x, z) : 10);

  function parkAll() {
    if (!pool) return;
    for (let i = 0; i < POD; i++) pool.park(i);
    pool.flush();
  }
  parkAll();

  function beginJoin(b) {
    mode = 'join';
    joinT = 0;
    // Enter from one side, ahead of the beam, all three from the same bearing
    // — a pod arrives as a pod.
    const sideSign = rng.chance(0.5) ? 1 : -1;
    const a = b.heading + sideSign * rng.range(0.7, 1.3);
    for (const d of pod) {
      d.x = b.position.x + Math.sin(a) * JOIN_DIST + rng.range(-3, 3);
      d.z = b.position.z + Math.cos(a) * JOIN_DIST + rng.range(-3, 3);
      d.y = -1.5;
      d.phase = rng.range(0, TAU);
      d.side = Math.abs(d.side) * sideSign * (rng.chance(0.7) ? 1 : -1);
    }
  }

  function update(ctx) {
    if (!pool) return;
    const b = ctx.boat;
    const dt = Math.min(0.05, ctx.dt || 0);
    const t = ctx.time;

    const speed = Math.abs(b.speed || 0);
    const busy = !!(ctx.fishing?.state?.active) || !!(ctx.shore?.state?.ashore);
    const deep = depthAt(b.position.x, b.position.z) > JOIN_DEPTH;
    const cruising = speed >= JOIN_SPEED[0] && speed <= JOIN_SPEED[1] && deep && !busy;

    if (mode === 'away') {
      timer -= dt * (cruising ? 1 : 0.15);   // the clock mostly runs while you cruise
      if (timer <= 0 && cruising) beginJoin(b);
      return;
    }

    if (mode === 'join') {
      joinT += dt;
      if (joinT > 14) { mode = 'escort'; timer = rng.range(ESCORT_TIME[0], ESCORT_TIME[1]); }
    } else if (mode === 'escort') {
      timer -= dt;
      // They leave when the ride stops being a ride — or when they have had
      // enough. `leave` just retargets the slots far abeam and lets the same
      // chase code carry them out; when the last one is 40 m out it parks.
      if (timer <= 0 || !cruising) mode = 'leave';
    }

    // --- chase the slots ----------------------------------------------------
    const fx = b.forward.x, fz = b.forward.z;
    const rx = -fz, rz = fx;
    let maxDist = 0;

    for (let i = 0; i < POD; i++) {
      const d = pod[i];
      const sideMul = mode === 'leave' ? 14 : 1;
      const tx = b.position.x + fx * d.ahead + rx * d.side * sideMul;
      const tz = b.position.z + fz * d.ahead + rz * d.side * sideMul;

      // Spring toward the slot, capped at a swimming speed a little over the
      // boat's — they can catch up, but they visibly WORK to.
      const dx = tx - d.x, dz = tz - d.z;
      const dist = Math.hypot(dx, dz);
      maxDist = Math.max(maxDist, dist);
      const vmax = mode === 'leave' ? 7.5 : Math.max(3.0, speed * 1.35 + 1.2);
      const accel = Math.min(1, dt * 1.6);
      d.vx = lerp(d.vx, (dx / Math.max(dist, 1e-4)) * Math.min(vmax, dist * 1.1), accel);
      d.vz = lerp(d.vz, (dz / Math.max(dist, 1e-4)) * Math.min(vmax, dist * 1.1), accel);
      d.x += d.vx * dt;
      d.z += d.vz * dt;

      // The porpoise. Phase runs with THEIR speed, so a pod loping beside a
      // slow boat arcs lazily and one chasing a brisk one drives harder.
      const sp = Math.hypot(d.vx, d.vz);
      d.phase += dt * (TAU / 2.6) * (0.55 + 0.45 * clamp(sp / 6, 0, 1));
      const s = Math.sin(d.phase);
      const surf = surfaceAt(d.x, d.z, t);
      d.y = surf + lerp(DIVE_Y, CREST_Y, s * 0.5 + 0.5);

      // Never into the seabed, whatever the water is doing.
      const bed = -depthAt(d.x, d.z);
      if (d.y < bed + 0.5) d.y = bed + 0.5;

      // Face the way it is going — with the kit's OWN convention. The creature
      // geometry carries its head on the -Z side of the body, so the yaw that
      // swims head-first is atan2(-vx, -vz); fishing.js's pose() and the
      // jumper both say so. This was atan2(vx, vz), which is exactly pi off,
      // and the whole pod escorted the boat tail-first — a fact no numeric
      // probe caught, because a probe checks positions and a backwards
      // dolphin's positions are perfect. Pitch follows the arc's slope,
      // clamped to a relaxed angle so the crest is a lean, not a launch.
      if (sp > 0.2) d.yaw = Math.atan2(-d.vx, -d.vz);
      const dy = Math.cos(d.phase) * (CREST_Y - DIVE_Y) * 0.5 * (TAU / 2.6);
      d.pitch = clamp(Math.atan2(dy, Math.max(sp, 1.5)), -0.75, 0.75);

      // Splash on the crossings, both ways. The burst is the same hand-drawn
      // foam the wake is made of, so a surfacing dolphin and a working hull
      // leave marks in the same voice.
      const above = d.y > surf - 0.05;
      if (burst && above !== d.wasAbove && mode !== 'away') {
        burst(d.x, d.z, above ? 4 : 2, above ? 0.9 : 0.55);
      }
      d.wasAbove = above;

      d.beat += dt * pool.beatRate * (0.8 + 0.4 * clamp(sp / 6, 0, 1));
      pool.set(i, d.x, d.y, d.z, d.yaw, d.pitch, 1, d.beat);
    }
    pool.flush();

    if (mode === 'leave' && maxDist > 40) {
      parkAll();
      mode = 'away';
      timer = rng.range(AWAY_TIME[0], AWAY_TIME[1]);
    }
  }

  return {
    update,
    // Nothing to relight: the pod wears the wildlife fish material, and
    // wildlife.applyEnv already owns that.
    applyEnv() {},
    get mode() { return mode; },
    dispose() { if (pool) pool.dispose(); },
  };
}
