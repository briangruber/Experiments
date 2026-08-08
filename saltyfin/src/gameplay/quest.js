// The objective. One small arc, three beats.
//
//   0  A Strange Disturbance   go and look at a marked patch of water north-east
//                              of the start, out toward the lighthouse island
//   1  The Water Turns         you are on top of it; the leviathan starts rising
//   2  Leviathan               it has broken the surface
//
// `state.stage` is the only thing another module is expected to read — the
// monster watches it to know when to come up — so it only ever counts upward and
// it is written before anything can observe a half-finished frame.
//
// The marker the HUD pins to is `state.targetPosition`. Until the creature is
// worth tracking that is the fixed patch of water; once it is awake the quest
// hands the HUD the creature's own position instead, so the compass pip and the
// range readout follow the thing you are actually chasing.

import * as THREE from 'three';

// The patch of water: out past the reef edge, off the boat's bow on the
// lighthouse side of north. From the start at (-6, 0, 24) that reads exactly
// 184 m a few degrees east of N, which is the framing in ref/05.
const MARK_X = 38.5;
const MARK_Z = -155;

const ARRIVE = 40;          // metres — how close counts as "there"
const ARRIVE_DWELL = 0.7;   // seconds inside that radius before the stage turns
const SURFACE_TRIGGER = 0.3;// monster.state.surfaced above this reads as breached
const RISE_TIMEOUT = 18;    // stage 1 gives up waiting and calls it a sighting

const BEATS = [
  {
    title: 'A Strange Disturbance',
    body: 'Investigate the waters near Greenwake Island.',
  },
  {
    title: 'The Water Turns',
    body: 'Something enormous is circling beneath the hull. Hold your position.',
  },
  {
    title: 'Leviathan',
    body: 'It has broken the surface. Keep your distance and log the sighting.',
  },
];

const RAD2DEG = 180 / Math.PI;

/** Finite-number guard — another module may hand us a half-built state. */
function fin(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

/** The creature's position, or null if the module has not published one yet. */
function creaturePos(monster) {
  const s = monster && monster.state;
  const p = s && s.position;
  if (!p) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return p;
}

export function createQuest({ ctx, monster } = {}) {
  const state = {
    title: BEATS[0].title,
    body: BEATS[0].body,
    targetPosition: new THREE.Vector3(MARK_X, 0, MARK_Z),
    /** Where the objective actually lives, before it is handed off to the creature. */
    markPosition: new THREE.Vector3(MARK_X, 0, MARK_Z),
    distance: 0,
    bearing: 0,        // radians, 0 = north, clockwise — same convention as boat.heading
    bearingDeg: 0,
    stage: 0,
    stageTime: 0,
    active: true,
    arrived: false,
  };

  let dwell = 0;

  // Seed the readouts so the first HUD frame is not a zero.
  {
    const b = ctx && ctx.boat && ctx.boat.position;
    const bx = fin(b && b.x, 0);
    const bz = fin(b && b.z, 0);
    const dx = state.targetPosition.x - bx;
    const dz = state.targetPosition.z - bz;
    state.distance = Math.sqrt(dx * dx + dz * dz);
    state.bearing = Math.atan2(dx, -dz);
    state.bearingDeg = state.bearing * RAD2DEG;
  }

  function advance(to) {
    if (to <= state.stage || to >= BEATS.length) return;
    state.stage = to;
    state.stageTime = 0;
    state.title = BEATS[to].title;
    state.body = BEATS[to].body;
  }

  return {
    state,
    group: null,
    applyEnv() {},

    update(c) {
      const dt = fin(c && c.dt, 0);
      state.stageTime += dt;

      const b = c && c.boat && c.boat.position;
      const bx = fin(b && b.x, 0);
      const bz = fin(b && b.z, 0);

      // Once the creature is awake it becomes the objective; before that the
      // objective is the patch of water that woke it.
      const cp = state.stage >= 1 ? creaturePos(monster) : null;
      if (cp) state.targetPosition.set(cp.x, fin(cp.y, 0), cp.z);
      else state.targetPosition.copy(state.markPosition);

      const dx = state.targetPosition.x - bx;
      const dz = state.targetPosition.z - bz;
      state.distance = Math.sqrt(dx * dx + dz * dz);
      state.bearing = Math.atan2(dx, -dz);
      state.bearingDeg = state.bearing * RAD2DEG;

      // Distance to the mark itself drives the first beat, even after the
      // target has been handed to the creature.
      const mdx = state.markPosition.x - bx;
      const mdz = state.markPosition.z - bz;
      const markDist = Math.sqrt(mdx * mdx + mdz * mdz);
      state.arrived = markDist < ARRIVE;

      if (state.stage === 0) {
        dwell = state.arrived ? dwell + dt : 0;
        if (dwell >= ARRIVE_DWELL) advance(1);
      } else if (state.stage === 1) {
        const ms = monster && monster.state;
        const surfaced = fin(ms && ms.surfaced, 0);
        const breached = ms && ms.breaching === true;
        if (surfaced > SURFACE_TRIGGER || breached || state.stageTime > RISE_TIMEOUT) advance(2);
      }
    },

    dispose() {},
  };
}
