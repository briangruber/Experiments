// Fishing. The boat stops, the camera goes under, and you work a lure.
//
// Four beats, and each one asks for a different thing:
//
//   JIG     Move the lure. Fish notice movement, not presence — hold it still
//           and nothing looks at you, snatch it about and they scatter. There
//           is a speed band that reads as a wounded baitfish and you have to
//           find it and stay in it while a fish closes.
//   STRIKE  One fish commits and comes in. A ring closes on the lure; set the
//           hook when the fish reaches it, not when you first see it move.
//           Early and it bolts, late and it spits.
//   FIGHT   Line in against a fish that runs. Reeling adds tension, a run adds
//           more, and the line parts at the top of the gauge. Pump between the
//           runs, give when it goes — and never sit on a slack line, because a
//           hook with no weight on it falls out.
//   LANDED  It comes up past the camera, and you get its name and its length.
//
// The skill is in three different currencies on purpose — rhythm, timing, then
// nerve — so none of them is the whole game.
//
// What this module owns: the state machine, the lure and its line, the fish
// that swim past, and the camera while it is under. What it does NOT own is
// how any of that is drawn as UI — hud/fishingHud.js does that and reads
// `state` — nor what a fish looks like. The animals come from wildlife.js's
// actor pools, so a fish on the end of a line is one of the same creatures
// swimming past the hull and not a lookalike kept in sync by hand.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// --- the rig -----------------------------------------------------------------

const DEPTH_MIN = 0.9;          // metres below the surface the lure can rise to
const DEPTH_MAX = 11.0;         // and the deepest it will ever go
const BED_CLEAR = 0.55;         // it never touches the sand
const JIG_RATE = 3.4;           // m/s the control moves the lure at full deflection

// The speed band that reads as a wounded fish. Under `JIG_DEAD` the lure is
// furniture; over `JIG_HOT` it is a threat. The band is wide enough to hold
// without staring at a meter and narrow enough that idle wobbling does not
// clear it.
const JIG_DEAD = 0.30;
const JIG_GOOD = 0.85;          // centre of the band
const JIG_HOT = 2.30;

// --- the camera --------------------------------------------------------------

const CAM_DIST = 2.45;
const CAM_ELEV = 0.20;          // radians above the lure
const CAM_LEAD = 0.55;          // metres the framing sits above the lure
const DIVE_TIME = 1.7;
const RISE_TIME = 1.25;

// --- the fish ----------------------------------------------------------------

// Each entry is one of wildlife.js's species with the numbers that make it a
// quarry rather than scenery. `pool` is how many of them can be in the water at
// once; `rate` is its share of the spawn.
//
// The ladder is deliberate: the little ones are easy to interest and easy to
// land and they teach the loop, the grouper is a wall that will part a line if
// you hold the reel down, and the ray is a rare thing that mostly cruises past
// without looking at you.
const QUARRY = [
  {
    key: 'damsel', name: 'Blue Damsel', pool: 3, rate: 0.26,
    band: [1.0, 4.5], speed: [0.55, 0.95],
    curious: 1.00, spook: 0.75, notice: 6.4,
    strikeTime: 1.05, stamina: 0.32, pull: 0.34, runs: [0.7, 1.3],
  },
  {
    key: 'sardine', name: 'Silverside', pool: 3, rate: 0.20,
    band: [0.9, 5.0], speed: [0.85, 1.35],
    curious: 0.92, spook: 1.15, notice: 6.0,
    strikeTime: 0.86, stamina: 0.28, pull: 0.30, runs: [0.5, 0.9],
  },
  {
    key: 'parrot', name: 'Reef Parrot', pool: 2, rate: 0.20,
    band: [1.6, 6.5], speed: [0.50, 0.85],
    curious: 0.72, spook: 0.85, notice: 7.0,
    strikeTime: 0.94, stamina: 0.62, pull: 0.66, runs: [0.9, 1.7],
  },
  {
    key: 'snapper', name: 'Coral Snapper', pool: 3, rate: 0.22,
    band: [2.0, 8.0], speed: [0.95, 1.55],
    curious: 0.84, spook: 1.00, notice: 7.6,
    strikeTime: 0.72, stamina: 0.58, pull: 0.72, runs: [0.6, 1.1],
  },
  {
    key: 'grouper', name: 'Old Man Grouper', pool: 2, rate: 0.09,
    band: [3.5, 10.5], speed: [0.40, 0.70],
    curious: 0.46, spook: 0.55, notice: 8.4,
    strikeTime: 1.20, stamina: 1.00, pull: 1.32, runs: [1.4, 2.6],
  },
  {
    key: 'ray', name: 'Shadow Ray', pool: 1, rate: 0.03,
    band: [4.5, 11.0], speed: [0.45, 0.75],
    curious: 0.26, spook: 0.40, notice: 9.2,
    strikeTime: 1.35, stamina: 1.30, pull: 1.05, runs: [2.0, 3.4],
  },
];

const RING_IN = 17;             // metres a fish is recycled past
const RING_OUT = [6, 12];       // where a new one enters

// --- the fight ---------------------------------------------------------------

const REEL_RATE = 1.55;         // m/s of line recovered, before the tension bonus
// Reeling always costs a little tension; reeling against a RUNNING fish costs
// that plus most of its pull. The numbers are set so that holding the reel
// through one full run is survivable and through two is not — which is the
// whole lesson of the beat, and it has to be learnable in one lost fish.
// Measured on the first pass at 0.46 + 0.75*pull: a snapper parted the line
// 1.2 seconds after the hook set, which is not a mistake anyone can see
// themselves make. This is 1.7 s of continuous reeling for a snapper, 2.8 for
// a damsel and 1.1 for the grouper, against runs of 0.6-2.6 s.
const TENSION_REEL = 0.13;      // per second of holding the reel at all
const TENSION_RUN = 0.48;       // times the fish's pull, while it is running
const TENSION_SLACK = 0.62;     // shed per second of not holding it
const SNAP_AT = 1.0;
const SLACK_GRACE = 2.1;        // seconds of a dead line before the hook drops out
const LAND_AT = 0.7;            // metres of line left that counts as landed

// -----------------------------------------------------------------------------

function buildLure() {
  const g = new THREE.Group();
  g.name = 'lure';

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 10, 7),
    new THREE.MeshStandardMaterial({ color: 0xE8E2CE, roughness: 0.34, metalness: 0.55 }),
  );
  body.scale.set(0.74, 0.74, 1.85);
  g.add(body);

  // The one hot colour in the whole frame. A lure is meant to be findable
  // against open water at ten metres and so is this — it is the thing the
  // player's eye tracks for the entire minigame.
  const skirt = new THREE.Mesh(
    new THREE.ConeGeometry(0.086, 0.26, 9, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xFF7A2E, roughness: 0.7, metalness: 0,
      emissive: 0xFF5A18, emissiveIntensity: 0.55, side: THREE.DoubleSide,
    }),
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.z = 0.205;
  g.add(skirt);

  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.028, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.25, metalness: 0.2 }),
  );
  eye.position.set(0.052, 0.018, -0.095);
  g.add(eye);
  const eye2 = eye.clone();
  eye2.position.x = -0.052;
  g.add(eye2);

  return g;
}

export function createFishing(opts = {}) {
  const {
    ctx, scene, input, boat, wildlife, water, terrain, camera, chaseCamera,
  } = opts;
  const rng = makeRng(((opts.seed | 0) ^ 0x1eaf17) >>> 0);

  const group = new THREE.Group();
  group.name = 'fishing';

  // --- rig meshes ----------------------------------------------------------
  const lure = buildLure();
  group.add(lure);

  // A line under tension is straight, so it is ONE cylinder that gets stretched
  // between the rod tip and the lure. A tube rebuilt per frame would allocate
  // every frame to draw the same shape.
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xE6F2FA, roughness: 0.5, metalness: 0.0,
    transparent: true, opacity: 0.55, depthWrite: false,
  });
  const lineMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 1, 5, 1, true), lineMat);
  lineMesh.name = 'line';
  group.add(lineMesh);

  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER);
  group.visible = false;
  scene.add(group);

  // --- actor pools ---------------------------------------------------------
  // One pool per species, sized to that species' `pool`. Built at boot so the
  // pipelines exist before the first cast; see wildlife.createActors.
  const pools = new Map();
  const fish = [];
  if (wildlife && typeof wildlife.createActors === 'function') {
    for (const q of QUARRY) {
      const pool = wildlife.createActors(q.key, q.pool);
      if (!pool) continue;
      pools.set(q.key, pool);
      for (let i = 0; i < q.pool; i++) {
        fish.push({
          q, pool, slot: i, live: false,
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          yaw: 0, pitch: 0, sc: 1, beat: 0, len: 0,
          interest: 0, spooked: 0, wander: rng.range(0, TAU),
        });
      }
    }
  }

  // --- state ---------------------------------------------------------------
  const state = {
    mode: 'off',          // off|stopping|diving|jig|strike|fight|landed|surfacing
    active: false,        // anything other than 'off'
    ownsCamera: false,
    depth: 2.4,           // metres below the surface
    jig: 0,               // 0..1 quality of the current lure action
    jigSpeed: 0,
    hooked: null,         // the fish record
    ring: 0,              // 1 -> 0 during the strike
    hookWindow: false,    // true while a press would set the hook
    tension: 0,
    line: 0,
    lineMax: 1,
    stamina: 1,
    running: 0,           // >0 while the fish is taking line
    message: '',
    catchName: '',
    catchLen: 0,
    catchBest: false,
    tally: 0,
    nearest: 0,           // metres to the most interested fish, for the HUD
    interest: 0,          // that fish's interest
    lost: '',
    // One line of teaching, shown until the player's first fish commits. The
    // jig is not a mechanic anyone guesses — "move the lure at the right speed
    // or nothing looks at it" has to be said once, and then never again.
    hint: '',
  };

  const TOUCH = typeof matchMedia === 'function'
    && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);
  const HINT = TOUCH
    ? 'Drag the left of the screen up and down to work the lure'
    : 'W / S works the lure · Space sets the hook and reels';
  let taught = false;

  // Personal bests, kept next to the ocean settings for the same reason: the
  // artifact reloads and a tally that resets every time is not a tally.
  const BEST_KEY = 'saltyfin-catch';
  let best = {};
  try { best = JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; } catch { best = {}; }
  if (typeof best !== 'object') best = {};
  state.tally = Number(best._n) || 0;

  function saveBest() {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* sandboxed */ }
  }

  // --- input latches -------------------------------------------------------
  // The HUD and the keyboard both feed these; nothing else reads raw input.
  let pressQueued = false;      // a tap, consumed by the next update
  let holding = false;          // the reel, held
  let jigAxis = 0;              // -1..1 from a drag or the arrow keys

  // --- camera --------------------------------------------------------------
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const fromPos = new THREE.Vector3();
  const fromLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const lureWorld = new THREE.Vector3();
  const rodWorld = new THREE.Vector3();
  let camOrbit = 0;
  let transition = 0;
  let savedFov = 0;

  function surfaceAt(x, z) {
    return water?.()?.sampleHeight ? water().sampleHeight(x, z, ctx.time) : 0;
  }
  function bedAt(x, z) {
    const t = terrain?.seabedHeight ? terrain.seabedHeight(x, z) : -12;
    return Number.isFinite(t) ? t : -12;
  }

  /** Where the lure hangs: outboard of the starboard rail, at `state.depth`. */
  function lurePosition(out) {
    const b = ctx.boat;
    const sx = b.position.x + b.right.x * 1.85 + b.forward.x * 0.55;
    const sz = b.position.z + b.right.z * 1.85 + b.forward.z * 0.55;
    const surf = surfaceAt(sx, sz);
    const bed = bedAt(sx, sz);
    const maxD = Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, surf - bed - BED_CLEAR));
    state.depth = clamp(state.depth, DEPTH_MIN, maxD);
    return out.set(sx, surf - state.depth, sz);
  }

  /** Rod tip in world space, from the boat's own anchor. */
  function rodPosition(out) {
    const b = ctx.boat;
    const anchor = boat?.rodTip;
    if (!anchor) return out.set(b.position.x, b.position.y + 1.6, b.position.z);
    // The anchor is boat-local; the hull's group carries the pose.
    if (boat.group) return out.copy(anchor).applyMatrix4(boat.group.matrixWorld);
    return out.set(b.position.x + anchor.x, b.position.y + anchor.y, b.position.z + anchor.z);
  }

  const _up = new THREE.Vector3(0, 1, 0);

  function placeLine(a, b) {
    tmp.subVectors(b, a);
    const len = tmp.length();
    if (len < 1e-4) { lineMesh.visible = false; return; }
    lineMesh.visible = true;
    lineMesh.position.copy(a).addScaledVector(tmp, 0.5);
    lineMesh.scale.set(1, len, 1);
    lineMesh.quaternion.setFromUnitVectors(
      _up, tmp.multiplyScalar(1 / len),
    );
  }

  /**
   * The framing. It orbits the LURE while you are working it and the FISH once
   * one is on, because those are two different shots: jigging is about the lure
   * and the water around it, and a fight is about the animal — and a camera
   * that stayed on the lure spent the whole fight looking at the empty water
   * the fish had just left, with the hull filling the top of the frame.
   *
   * The distance opens with the line out so a long run does not shrink the fish
   * to nothing, and closes again as you win it back.
   */
  const _focus = new THREE.Vector3();

  function fishingCamera(outPos, outLook) {
    const b = ctx.boat;
    const onFish = state.hooked && (state.mode === 'fight' || state.mode === 'landed');
    let dist = CAM_DIST;
    if (onFish) {
      _focus.set(state.hooked.x, state.hooked.y, state.hooked.z);
      dist = clamp(2.5 + state.line * 0.30, 2.5, 5.2);
    } else {
      _focus.copy(lureWorld);
    }
    const a = b.heading + camOrbit + Math.PI * 0.42;
    const ce = Math.cos(CAM_ELEV);
    outPos.set(
      _focus.x + Math.sin(a) * dist * ce,
      _focus.y + Math.sin(CAM_ELEV) * dist + CAM_LEAD,
      _focus.z + Math.cos(a) * dist * ce,
    );
    // Never break the surface — half in and half out is a different shot and
    // it is not this one — and never scrape the sand.
    const surf = surfaceAt(outPos.x, outPos.z);
    const bed = bedAt(outPos.x, outPos.z);
    // `bed + 0.65` can sit ABOVE `surf - 0.75` over a shallow reef, and a naive
    // clamp then returns the low bound and puts the eye in the air. Take the
    // midpoint of the two when the water is too thin to hold the camera.
    const lo = bed + 0.65, hi = surf - 0.75;
    outPos.y = lo > hi ? (lo + hi) * 0.5 : clamp(outPos.y, lo, hi);
    outLook.set(_focus.x, _focus.y + 0.10, _focus.z);
  }

  // --- fish ----------------------------------------------------------------

  function spawn(f) {
    const q = f.q;
    const surf = surfaceAt(lureWorld.x, lureWorld.z);
    const bed = bedAt(lureWorld.x, lureWorld.z);
    const a = rng.range(0, TAU);
    const r = rng.range(RING_OUT[0], RING_OUT[1]);
    const depth = rng.range(q.band[0], q.band[1]);
    const y = clamp(surf - depth, bed + 0.5, surf - 0.5);
    f.x = lureWorld.x + Math.sin(a) * r;
    f.z = lureWorld.z + Math.cos(a) * r;
    f.y = y;
    // Heading roughly across the lure rather than at it, so an approach reads
    // as a decision the fish made and not as a spawn aimed at the player.
    const toward = Math.atan2(lureWorld.x - f.x, lureWorld.z - f.z);
    const cross = toward + rng.range(-0.55, 0.55) + (rng.next() < 0.5 ? 0.42 : -0.42);
    const sp = rng.range(q.speed[0], q.speed[1]);
    f.vx = Math.sin(cross) * sp;
    f.vz = Math.cos(cross) * sp;
    f.vy = rng.range(-0.05, 0.05);
    f.sc = rng.range(0.85, 1.32);
    f.len = f.pool.len * f.sc;
    f.interest = 0;
    f.spooked = 0;
    f.live = true;
    f.beat = rng.range(0, TAU);
    f.wander = rng.range(0, TAU);
  }

  function updateFish(dt) {
    const surf = surfaceAt(lureWorld.x, lureWorld.z);
    const bed = bedAt(lureWorld.x, lureWorld.z);
    let bestF = null;

    for (const f of fish) {
      if (f === state.hooked) continue;
      if (!f.live) {
        // Trickle them in rather than filling the water at once: the sea is
        // supposed to feel like it has fish IN it, not like a spawner.
        if (rng.next() < f.q.rate * dt * 2.2) spawn(f);
        else { f.pool.park(f.slot); continue; }
      }

      const dx = lureWorld.x - f.x, dy = lureWorld.y - f.y, dz = lureWorld.z - f.z;
      const d = Math.hypot(dx, dy, dz);

      // ---- interest ------------------------------------------------------
      // Only a lure that is MOVING is a lure. `state.jig` is 1 in the band and
      // falls off either side of it; over the top it is negative, and that is
      // what a fish flees from.
      if (f.spooked > 0) {
        f.spooked -= dt;
        f.interest = Math.max(0, f.interest - dt * 1.6);
      } else if (d < f.q.notice) {
        const near = 1 - d / f.q.notice;
        if (state.jig > 0) {
          f.interest = Math.min(1, f.interest + dt * state.jig * f.q.curious * near * 0.62);
        } else {
          // Too still, or too violent. Violent also scares.
          f.interest = Math.max(0, f.interest + dt * state.jig * f.q.spook * 1.4);
          if (state.jig < -0.5 && f.interest > 0.15 && rng.next() < dt * 2.2) {
            f.spooked = rng.range(2.5, 5.0);
          }
        }
      } else {
        f.interest = Math.max(0, f.interest - dt * 0.30);
      }

      // ---- steering ------------------------------------------------------
      f.wander += dt * 0.9;
      let ax = 0, ay = 0, az = 0;
      const sp = Math.hypot(f.vx, f.vy, f.vz) || 1e-4;

      if (f.spooked > 0) {
        // Away, fast, and it does not look back.
        const inv = 1 / Math.max(d, 1e-3);
        ax = -dx * inv * 5.5; ay = -dy * inv * 2.0; az = -dz * inv * 5.5;
      } else if (f.interest > 0.22) {
        // Closing. The approach tightens as interest rises, and it hangs off
        // at a stand-off distance rather than swimming into the lure — a fish
        // that has not committed circles.
        const want = lerp(1.9, 0.42, smooth(clamp((f.interest - 0.22) / 0.78, 0, 1)));
        const err = d - want;
        const inv = 1 / Math.max(d, 1e-3);
        const g = clamp(err, -1.2, 1.6) * 2.4;
        ax = dx * inv * g; ay = dy * inv * g * 0.8; az = dz * inv * g;
        // A slow orbit around the lure, so a held fish is alive rather than
        // parked nose-on.
        ax += Math.sin(f.wander * 1.7) * 0.55 * f.interest;
        az += Math.cos(f.wander * 1.7) * 0.55 * f.interest;
      } else {
        // Cruising. Gentle wander, a pull back into its depth band — and a weak
        // draw toward the boat's patch of water.
        //
        // That last one is not a cheat, it is the difference between a game and
        // a wait. Measured without it: 22 seconds of correct jigging with every
        // fish in the water and the closest one never came inside 12.7 m, so
        // `notice` never fired and interest never left zero. A boat sitting
        // still over a reef with something flashing under it does gather fish;
        // this is that, at a gain small enough that they still wander off.
        const hold = 4.2;
        const ring = (d - hold) * 0.16;
        const inv = 1 / Math.max(d, 1e-3);
        ax = dx * inv * ring;
        az = dz * inv * ring;
        ax += Math.sin(f.wander * 0.8 + f.slot) * 0.30;
        az += Math.cos(f.wander * 0.7 + f.slot * 2.1) * 0.30;
        const wantY = clamp(surf - lerp(f.q.band[0], f.q.band[1], 0.5 + 0.5 * Math.sin(f.wander * 0.35)),
          bed + 0.5, surf - 0.5);
        ay = clamp(wantY - f.y, -1, 1) * 0.9;
      }

      f.vx += ax * dt; f.vy += ay * dt; f.vz += az * dt;
      const damp = 1 - Math.min(0.9, 1.6 * dt);
      f.vx *= damp; f.vy *= damp; f.vz *= damp;
      const vmax = f.q.speed[1] * (f.spooked > 0 ? 3.4 : f.interest > 0.5 ? 1.5 : 1.0);
      const s2 = Math.hypot(f.vx, f.vy, f.vz);
      if (s2 > vmax) { const k = vmax / s2; f.vx *= k; f.vy *= k; f.vz *= k; }

      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      f.y = clamp(f.y, bed + 0.35, surf - 0.30);

      // Recycle when it has left, or once its scare has run out a long way off.
      const away = Math.hypot(f.x - lureWorld.x, f.z - lureWorld.z);
      if (away > RING_IN) { f.live = false; f.pool.park(f.slot); continue; }

      pose(f, dt);
      if (!bestF || f.interest > bestF.interest) bestF = f;
    }

    state.nearest = bestF ? Math.hypot(bestF.x - lureWorld.x, bestF.y - lureWorld.y, bestF.z - lureWorld.z) : 0;
    state.interest = bestF ? bestF.interest : 0;
    return bestF;
  }

  /** Write one fish's pose into its actor pool. */
  function pose(f, dt) {
    const sp = Math.hypot(f.vx, f.vy, f.vz);
    if (sp > 1e-4) {
      f.yaw = Math.atan2(-f.vx, -f.vz);
      f.pitch = clamp(Math.asin(clamp(f.vy / sp, -1, 1)), -0.5, 0.5);
    }
    // Tail rate rises with speed, which is the difference between a fish
    // gliding and a fish working.
    f.beat += dt * f.pool.beatRate * (0.55 + 0.75 * clamp(sp / (f.q.speed[1] || 1), 0, 2.2));
    f.pool.set(f.slot, f.x, f.y, f.z, f.yaw, f.pitch, f.sc, f.beat);
  }

  function flushPools() {
    for (const p of pools.values()) p.flush();
  }

  /** Put a few in the water at once, so the first cast is not into a desert. */
  function seedFish() {
    let n = 0;
    for (const f of fish) {
      if (n >= 5) break;
      if (rng.next() < f.q.rate * 3.2) { spawn(f); n++; }
    }
    flushPools();
  }

  function parkAll() {
    for (const f of fish) { f.live = false; f.pool.park(f.slot); }
    flushPools();
  }

  // --- beats ---------------------------------------------------------------

  function beginStrike(f) {
    taught = true;
    state.hint = '';
    state.hooked = f;
    state.mode = 'strike';
    state.ring = 1;
    state.hookWindow = false;
    state.message = 'Set the hook!';
    strikeT = 0;
    // Where it started from, so the run at the lure is an interpolation and
    // arrives exactly when the ring closes rather than whenever a steering
    // force happens to get it there.
    strikeFrom.set(f.x, f.y, f.z);
  }
  let strikeT = 0;
  const strikeFrom = new THREE.Vector3();

  function missStrike(why) {
    const f = state.hooked;
    if (f) { f.spooked = rng.range(3.5, 6.0); f.interest = 0; }
    state.hooked = null;
    state.mode = 'jig';
    state.message = why;
    messageT = 1.6;
  }
  let messageT = 0;

  function beginFight(f) {
    state.mode = 'fight';
    state.hooked = f;
    state.line = Math.hypot(f.x - rodWorld.x, f.y - rodWorld.y, f.z - rodWorld.z);
    state.lineMax = Math.max(state.line, 4);
    state.tension = 0.18;
    state.stamina = 1;
    state.running = 0.5;      // it bolts the instant it feels the hook
    slackT = 0;
    state.message = '';
    runWait = 0;
  }
  let slackT = 0;
  let runWait = 0;

  function loseFish(why) {
    state.mode = 'jig';
    state.lost = why;
    state.message = why;
    messageT = 2.2;
    const f = state.hooked;
    if (f) { f.spooked = rng.range(4, 7); f.interest = 0; }
    state.hooked = null;
    state.tension = 0;
  }

  function landFish() {
    const f = state.hooked;
    const q = f.q;
    const cm = Math.round(f.len * 100);
    state.catchName = q.name;
    state.catchLen = cm;
    state.catchBest = cm > (best[q.key] || 0);
    if (state.catchBest) best[q.key] = cm;
    best._n = (Number(best._n) || 0) + 1;
    state.tally = best._n;
    saveBest();
    // Everything nearby scatters. Without it the next fish, whose interest was
    // already at 1 while you were playing this one, commits on the same frame
    // the catch card clears — and two catches back to back with no water in
    // between reads as a slot machine rather than as fishing.
    for (const other of fish) {
      if (other === f || !other.live) continue;
      const d = Math.hypot(other.x - f.x, other.y - f.y, other.z - f.z);
      other.interest = 0;
      if (d < 7) other.spooked = rng.range(1.6, 3.4);
    }
    state.mode = 'landed';
    landT = 0;
    state.message = '';
  }
  let landT = 0;

  // --- the four beats ------------------------------------------------------

  function updateJig(dt) {
    const bestF = updateFish(dt);
    if (bestF && bestF.interest >= 0.995 && bestF.spooked <= 0) beginStrike(bestF);
  }

  function updateStrike(dt) {
    const f = state.hooked;
    if (!f) { state.mode = 'jig'; return; }
    const dur = f.q.strikeTime;
    strikeT += dt;
    state.ring = clamp(1 - strikeT / dur, 0, 1);

    // The fish drives at the lure and its nose ARRIVES as the ring closes, so
    // the ring is a readout of the animal rather than a separate abstract
    // timer laid over it. It over-runs slightly past the lure, which is what
    // makes the last fifth of the ring the late window.
    const t = smooth(clamp(strikeT / (dur * 0.88), 0, 1));
    const dx = lureWorld.x - strikeFrom.x;
    const dy = lureWorld.y - strikeFrom.y;
    const dz = lureWorld.z - strikeFrom.z;
    f.x = strikeFrom.x + dx * t;
    f.y = strikeFrom.y + dy * t;
    f.z = strikeFrom.z + dz * t;
    f.vx = dx; f.vy = dy; f.vz = dz;
    pose(f, dt);
    updateFish(dt);

    // The window sits at the END of the ring, where the fish's mouth is on the
    // lure. `strike when you see it move` fails; `strike when it gets there`
    // works. That is the whole lesson of the beat and it is worth being strict
    // about — 0.26 s at the snapper's tempo.
    state.hookWindow = state.ring <= 0.30 && state.ring > 0.02;

    if (pressQueued) {
      pressQueued = false;
      if (state.hookWindow) beginFight(f);
      else missStrike(state.ring > 0.30 ? 'Too early — it bolted.' : 'Too late — it spat the lure.');
      return;
    }
    if (strikeT > dur + 0.10) missStrike('Too late — it spat the lure.');
  }

  function updateFight(dt) {
    const f = state.hooked;
    if (!f) { state.mode = 'jig'; return; }
    const q = f.q;

    // ---- the fish's own decisions ------------------------------------------
    if (state.running > 0) {
      state.running -= dt;
    } else {
      runWait -= dt;
      if (runWait <= 0) {
        // A tired fish runs less often and for less time. That is the whole
        // arc of a fight: it wins the first thirty seconds and you win the
        // last ten.
        const rest = lerp(2.6, 0.7, 1 - state.stamina);
        if (state.stamina > 0.06 && rng.next() < 0.55) {
          state.running = rng.range(q.runs[0], q.runs[1]) * (0.35 + 0.65 * state.stamina);
        }
        runWait = rest * rng.range(0.7, 1.3);
      }
    }

    const running = state.running > 0;
    const pull = q.pull * (0.30 + 0.70 * state.stamina) * (running ? 1 : 0.22);

    // ---- line and tension ---------------------------------------------------
    if (holding) {
      // Reeling against a running fish is what parts line. Reeling while it
      // rests is nearly free — which is the pump.
      const gain = REEL_RATE * (running ? 0.42 : 1.0) * (0.55 + 0.45 * (1 - state.tension));
      state.line = Math.max(0, state.line - gain * dt);
      state.tension += (TENSION_REEL + pull * TENSION_RUN) * dt;
      state.stamina -= dt * (0.055 + 0.30 * state.tension) * (1 / (0.35 + q.stamina));
    } else {
      state.tension -= TENSION_SLACK * dt;
      state.stamina -= dt * 0.012 * (1 / (0.35 + q.stamina));
    }
    if (running) state.line += pull * dt * (holding ? 0.85 : 1.25);

    state.tension = clamp(state.tension, 0, 1.25);
    state.stamina = clamp(state.stamina, 0, 1);
    state.line = Math.min(state.line, state.lineMax * 1.6);

    // ---- the two ways to lose ----------------------------------------------
    if (state.tension >= SNAP_AT) { loseFish('The line parted.'); return; }
    if (state.tension < 0.055) {
      slackT += dt;
      if (slackT > SLACK_GRACE) { loseFish('Slack line — the hook fell out.'); return; }
    } else slackT = 0;

    // ---- drag the fish along the line --------------------------------------
    // Its position is derived from how much line is out, so the gauge and the
    // animal always agree — a fight where the bar says one thing and the water
    // says another is unreadable.
    const dx = f.x - rodWorld.x, dy = f.y - rodWorld.y, dz = f.z - rodWorld.z;
    const d = Math.hypot(dx, dy, dz) || 1e-4;
    const want = Math.max(0.25, state.line);
    const k = want / d;
    // Ease rather than snap, and let it thrash across the line while it runs.
    const ex = rodWorld.x + dx * k, ey = rodWorld.y + dy * k, ez = rodWorld.z + dz * k;
    const rate = Math.min(1, dt * 7);
    f.x += (ex - f.x) * rate;
    f.y += (ey - f.y) * rate;
    f.z += (ez - f.z) * rate;
    if (running) {
      const a = ctx.time * 2.6;
      f.x += Math.sin(a) * 0.55 * dt * 6;
      f.z += Math.cos(a * 1.3) * 0.55 * dt * 6;
      f.y += Math.sin(a * 0.7) * 0.28 * dt * 6;
    }
    const surf = surfaceAt(f.x, f.z);
    const bed = bedAt(f.x, f.z);
    f.y = clamp(f.y, bed + 0.3, surf - 0.12);

    // Face the way it is being pulled, or away from it while it runs.
    const tx = running ? f.x - rodWorld.x : rodWorld.x - f.x;
    const tz = running ? f.z - rodWorld.z : rodWorld.z - f.z;
    f.vx = tx; f.vz = tz; f.vy = (running ? -0.3 : 0.5);
    pose(f, dt);
    updateFish(dt);

    if (state.line <= LAND_AT) landFish();
  }

  function updateLanded(dt) {
    landT += dt;
    const f = state.hooked;
    if (f) {
      // Up to just under the ceiling, and it STAYS there. The first version
      // lifted it clean out of the water, which from an eye that is itself
      // underwater means the prize leaves the frame the instant it is won —
      // the camera cannot follow it through the surface and the card ends up
      // floating over empty water. Held at 30 cm under, silhouetted against
      // the bright underside with the line taut to the rod, it is visible for
      // the whole card.
      const t = clamp(landT / 1.1, 0, 1);
      const surf = surfaceAt(f.x, f.z);
      f.y = lerp(f.y, surf - 0.30, Math.min(1, dt * 3.2));
      f.x = lerp(f.x, rodWorld.x, Math.min(1, dt * 1.6));
      f.z = lerp(f.z, rodWorld.z, Math.min(1, dt * 1.6));
      f.vx = 0; f.vy = 1; f.vz = 0.001;
      // Thrashing, not spinning: a fish on a short line swings about the line
      // rather than rotating on the spot.
      f.yaw += Math.sin(ctx.time * 7.5) * dt * 2.6;
      f.pitch = lerp(f.pitch, 0.35 + Math.sin(ctx.time * 5.5) * 0.25, Math.min(1, dt * 3));
      f.beat += dt * f.pool.beatRate * 2.4;      // it is not happy about this
      f.pool.set(f.slot, f.x, f.y, f.z, f.yaw, f.pitch, f.sc, f.beat, f.q.key === 'ray' ? 0.09 : 0.22);
      if (t >= 1 && landT > 2.6) {
        f.live = false;
        f.pool.park(f.slot);
        state.hooked = null;
        state.mode = 'jig';
        state.catchName = '';
      }
    } else if (landT > 2.6) {
      state.mode = 'jig';
      state.catchName = '';
    }
    updateFish(dt);
  }

  // --- public ---------------------------------------------------------------

  /**
   * `instant` skips the stop and the dive and lands in the jig with the camera
   * already placed. It exists for the capture harness, which gets a dozen
   * frames in fifteen seconds under a software rasteriser and would otherwise
   * only ever photograph the descent.
   */
  function start(instant) {
    if (state.active) return;
    state.mode = 'stopping';
    state.active = true;
    state.message = 'Bringing her to a stop…';
    state.lost = '';
    state.depth = 2.4;
    camOrbit = 0;
    transition = 0;
    savedFov = camera.fov;
    group.visible = true;
    // The helm stands down for the whole session. boatController reads this
    // rather than fishing writing throttle behind its back — one owner of the
    // hull, and a keyboard W during a fight must not drive the boat away from
    // the fish on the line.
    ctx.fishingHold = true;
    // Kill way immediately: a helm that is still fighting you while the camera
    // dives is the one thing that makes this feel broken rather than cinematic.
    input?.setTouchAxes?.(0, 0);
    if (instant) {
      ctx.boat.speed = 0;
      ctx.boat.throttle = 0;
      transition = 1;
      state.mode = 'jig';
      state.message = 'Work the lure.';
      messageT = 2.6;
      if (!taught) state.hint = HINT;
      lurePosition(lureWorld);
      fishingCamera(camPos, camLook);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      camera.fov = 58;
      camera.updateProjectionMatrix();
      state.ownsCamera = true;
      seedFish();
    }
  }

  function stop() {
    if (!state.active) return;
    if (state.mode === 'surfacing' || state.mode === 'off') return;
    state.mode = 'surfacing';
    state.hint = '';
    ctx.fishingHold = false;
    transition = 0;
    state.hooked = null;
    state.message = '';
    parkAll();
    fromPos.copy(camera.position);
    camera.getWorldDirection(tmp);
    fromLook.copy(camera.position).addScaledVector(tmp, 6);
  }

  function toggle() { if (state.active) stop(); else start(); }

  /** A tap: set the hook, or dismiss a catch card. */
  function press() {
    if (state.mode === 'landed') { landT = Math.max(landT, 2.6); return; }
    pressQueued = true;
  }
  /** The reel, held. */
  function setHold(v) { holding = !!v; }
  /** -1..1: down is deeper, matching a drag. */
  function setJig(v) { jigAxis = clamp(Number(v) || 0, -1, 1); }

  let lastDepth = 2.4;
  let jigSmooth = 0;

  function update(c) {
    const dt = Math.min(0.05, c.dt || 0);
    if (!state.active) {
      state.ownsCamera = false;
      if (group.visible) group.visible = false;
      return;
    }

    // ---- lure and rig -------------------------------------------------------
    lurePosition(lureWorld);
    rodPosition(rodWorld);

    // The jig. Keyboard and drag both land in jigAxis; the depth it produces is
    // what the fish actually reads, so a control that is fighting the seabed
    // clamp scores as though it were still — which is correct, because it is.
    if (state.mode === 'jig' || state.mode === 'strike') {
      const keyAxis = (input?.isDown?.('KeyS') || input?.isDown?.('ArrowDown') ? 1 : 0)
        - (input?.isDown?.('KeyW') || input?.isDown?.('ArrowUp') ? 1 : 0);
      const axis = keyAxis !== 0 ? keyAxis : jigAxis;
      state.depth += axis * JIG_RATE * dt;
      lurePosition(lureWorld);
    }

    const moved = Math.abs(state.depth - lastDepth) / Math.max(dt, 1e-4);
    lastDepth = state.depth;
    jigSmooth = lerp(jigSmooth, moved, Math.min(1, dt * 9));
    state.jigSpeed = jigSmooth;
    // 1 in the band, tapering to 0 at the dead end and going NEGATIVE past the
    // hot end, which is what makes over-working the lure a mistake rather than
    // merely useless.
    state.jig = jigSmooth < JIG_GOOD
      ? smooth(clamp((jigSmooth - JIG_DEAD) / (JIG_GOOD - JIG_DEAD), 0, 1))
      : jigSmooth < JIG_HOT
        ? 1 - 0.7 * smooth(clamp((jigSmooth - JIG_GOOD) / (JIG_HOT - JIG_GOOD), 0, 1))
        : -clamp((jigSmooth - JIG_HOT) / 1.6, 0, 1);

    // Once a fish is on, the lure is IN it: it rides at the fish's mouth and
    // the line runs from the rod to there. Leaving it hanging at the set depth
    // drew a line to a lure the fish was not attached to, which is the one
    // detail in the whole beat that gives the illusion away.
    if (state.hooked && (state.mode === 'fight' || state.mode === 'landed')) {
      const f = state.hooked;
      lureWorld.set(
        f.x - Math.sin(f.yaw) * f.len * 0.46,
        f.y + f.len * 0.04,
        f.z - Math.cos(f.yaw) * f.len * 0.46,
      );
      lure.rotation.set(-0.4, f.yaw, 0);
    } else {
      lure.rotation.set(-1.25 + clamp(jigSmooth * 0.22, 0, 0.5), ctx.boat.heading, 0);
    }
    lure.position.copy(lureWorld);
    placeLine(rodWorld, lureWorld);

    if (messageT > 0) { messageT -= dt; if (messageT <= 0) state.message = ''; }

    // ---- the machine --------------------------------------------------------
    switch (state.mode) {
      case 'stopping': {
        const b = ctx.boat;
        b.throttle *= Math.max(0, 1 - dt * 6);
        b.speed *= Math.max(0, 1 - dt * 2.4);
        if (Math.abs(b.speed) < 0.35) {
          state.mode = 'diving';
          transition = 0;
          fromPos.copy(camera.position);
          camera.getWorldDirection(tmp);
          fromLook.copy(camera.position).addScaledVector(tmp, 8);
          state.message = '';
          parkAll();
        }
        break;
      }
      case 'diving': {
        ctx.boat.throttle = 0;
        ctx.boat.speed *= Math.max(0, 1 - dt * 2.4);
        transition = Math.min(1, transition + dt / DIVE_TIME);
        const t = smooth(transition);
        fishingCamera(camPos, camLook);
        camera.position.lerpVectors(fromPos, camPos, t);
        tmp.lerpVectors(fromLook, camLook, t);
        camera.lookAt(tmp);
        camera.fov = lerp(savedFov, 58, t);
        camera.updateProjectionMatrix();
        state.ownsCamera = true;
        if (transition >= 1) {
          state.mode = 'jig';
          state.message = 'Work the lure.';
          messageT = 2.6;
          if (!taught) state.hint = HINT;
          seedFish();
        }
        break;
      }
      case 'jig': updateJig(dt); break;
      case 'strike': updateStrike(dt); break;
      case 'fight': updateFight(dt); break;
      case 'landed': updateLanded(dt); break;
      case 'surfacing': {
        transition = Math.min(1, transition + dt / RISE_TIME);
        const t = smooth(transition);
        // Hand back to the chase rig by aiming at where it wants to be.
        chaseCamera?.update?.(c);
        tmp.copy(camera.position);
        camera.getWorldDirection(camLook);
        camLook.multiplyScalar(6).add(tmp);
        camera.position.lerpVectors(fromPos, tmp, t);
        camera.lookAt(fromLook.lerp(camLook, t));
        camera.fov = lerp(58, savedFov, t);
        camera.updateProjectionMatrix();
        state.ownsCamera = true;
        if (transition >= 1) {
          state.mode = 'off';
          state.active = false;
          state.ownsCamera = false;
          group.visible = false;
          camera.fov = savedFov;
          camera.updateProjectionMatrix();
        }
        break;
      }
      default: break;
    }

    // The camera, for every beat that is not a transition.
    if (state.mode === 'jig' || state.mode === 'strike'
      || state.mode === 'fight' || state.mode === 'landed') {
      // A drag orbits the framing, gently, and it holds where it is left — down
      // here there is nothing to recentre on.
      if (input?.pointer?.down) camOrbit += input.pointer.dx * 0.0026;
      fishingCamera(camPos, camLook);
      camera.position.lerp(camPos, Math.min(1, dt * 4.5));
      camera.lookAt(camLook);
      camera.fov = 58;
      camera.updateProjectionMatrix();
      state.ownsCamera = true;
      ctx.boat.throttle = 0;
    }

    pressQueued = false;
    flushPools();
  }

  function applyEnv(env) {
    if (!env) return;
    // The lure is lit by the water like everything else down there, and the
    // line has to stay visible against a dark seabed at night.
    lineMat.opacity = 0.35 + 0.30 * env.dayFactor;
  }

  return {
    group,
    state,
    update,
    applyEnv,
    start, stop, toggle, press, setHold, setJig,
    get best() { return best; },
    /** The one number the HUD needs that is not in `state`. */
    bestFor(key) { return best[key] || 0; },
    quarry: QUARRY,
    dispose() {
      lure.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      lineMesh.geometry.dispose();
      lineMat.dispose();
      group.clear();
    },
  };
}
