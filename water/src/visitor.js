// The thing in the dark at the back of the tank.
//
// An easter egg, so it is deliberately not in the interface and never
// announced: it comes out of the fog on its own every few minutes, crosses the
// tank, and goes back into it. Typing `fish` brings it out on demand, which is
// how anyone who suspects it can confirm it.
//
// It arrives rigged, so the swimming is the rig's: a travelling wave down the
// tail, driven by sines, with the body's own sway and lean phase-locked to the
// same beat. That last part is what stops it reading as two animations played
// over each other — in a real fish the beat IS the propulsion, so the body
// sways because the tail beat threw it, and both have to come off one clock.
//
// Both backends drive this the same way; only the mesh construction differs, so
// they hand one in.

import { TUNE } from './tune.js';

const IDLE_MIN = 150;    // earliest it will come out on its own, seconds
const IDLE_MAX = 420;    // and the latest

// The rig, by index into the baked joint list. Worked out from the joints'
// world positions and their world AXES, not their names — UniRig calls them
// Bone_000..013 in no useful order. The fish faces +Z; 10 -> 11 -> 12 -> 13 is
// the chain running back to the tail tip at z = -0.92.
//
// Every bone here points along its own local +Y, which is the convention and
// also the trap: a sideways beat is not rotation.y, that is the bone twisting
// about its own length. For the tail chain local Z comes out as world up, so
// the beat is about local Z. The jaw pair is the other case — bone 4 runs
// forward and DOWN, bone 6 forward and up, and both keep local X on world X,
// so the mouth opens by turning them about local X in opposite directions.
const TAIL = [10, 11, 12, 13];
const TAIL_AMP = [0.06, 0.11, 0.17, 0.24];   // scaled by TUNE.tailAmp
const DORSAL = [8, 9];
const JAW = [[4, 1], [6, -1]];   // bone, and which way it swings open

// `model` is { mesh, bones, sync } from riggedModel.
export function createVisitor(THREE, model, tankHalf) {
  const mesh = model.mesh;
  const bones = model.bones;
  // The pose out of the file, kept so every beat COMPOSES with it. Writing
  // bone.rotation.z would instead replace the z term of the bind rotation's
  // own euler, which throws the joint off its rest pose before it has bent
  // anywhere.
  const rest = bones ? bones.map((b) => b.quaternion.clone()) : null;
  const AX_Z = bones ? new THREE.Vector3(0, 0, 1) : null;
  const AX_X = bones ? new THREE.Vector3(1, 0, 0) : null;
  const spin = bones ? new THREE.Quaternion() : null;
  const bend = (i, axis, angle) => {
    const b = bones[i];
    if (b) b.quaternion.copy(rest[i]).multiply(spin.setFromAxisAngle(axis, angle));
  };
  const state = {
    mesh,
    t: 0,                       // 0..1 across the tank, or -1 when away
    next: IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN),
    // each visit picks its own lane and direction, so it is never the same
    lane: 0, depth: 0, dir: 1, phase: 0, fade: 1,
  };
  mesh.visible = false;

  function begin() {
    state.t = 0;
    state.dir = Math.random() < 0.5 ? 1 : -1;
    state.lane = (Math.random() - 0.5) * 0.9 * tankHalf;
    // The camera aims up toward the waterline, so the visible band sits above
    // the tank's centre: a fish swimming at mid-depth crosses off the bottom
    // of the frame entirely.
    state.depth = (-0.06 + Math.random() * 0.30) * tankHalf;
    state.phase = Math.random() * 6.283;
    mesh.visible = true;
  }

  function update(dt, tankHalfNow) {
    const h = tankHalfNow ?? tankHalf;
    if (!mesh.visible) {
      state.next -= dt;
      if (state.next <= 0) {
        state.next = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
        begin();
      }
      return;
    }

    state.t += dt / TUNE.cross;
    if (state.t >= 1) { mesh.visible = false; state.t = -1; return; }

    // Comes forward out of the far fog, turns at the near end and goes back
    // into it. A straight crossing on z runs through the camera, which sits
    // just outside the front glass — the fish arrived as a wall of scales
    // rather than as something glimpsed.
    const u = state.t;
    const s = Math.sin(Math.PI * u);            // 0 at both ends, 1 at the apex
    // One clock for the whole animal, in seconds rather than in crossing
    // fraction so the beat does not change rate if CROSS is retuned.
    const beat = u * TUNE.cross * TUNE.beat + state.phase;

    // It comes from WELL behind the tank and goes back there — far enough that
    // it has finished dissolving long before it turns around, so nothing is
    // ever switched on or off while it can be seen. Keeping it inside the
    // glass was the previous attempt at this and it only moved the problem:
    // the back wall is barely a tank-length away, which is not enough water to
    // hide anything in, so it still surfaced out of nothing.
    const z = (-TUNE.reach + (TUNE.reach - 0.1) * s) * h;
    const drift = (u - 0.5) * 0.8 * h * state.dir;
    // Small now: the tail carries the beat, so the body only needs the recoil
    // it would actually get. At the old amplitude the whole fish slalomed.
    const x = state.lane + drift + Math.sin(beat) * 0.035 * h;
    const y = state.depth + Math.sin(beat * 0.5) * 0.03 * h;
    mesh.position.set(x, y, z);

    // A travelling wave down the tail, which is what a fish actually does: each
    // joint lags the one ahead of it and swings further, so the bend moves
    // BACKWARDS along the body while the body moves forwards. One phase for
    // every joint would wag it like a metronome.
    if (bones) {
      for (let i = 0; i < TAIL.length; i++) {
        bend(TAIL[i], AX_Z, Math.sin(beat - (i + 1) * TUNE.lag) * TAIL_AMP[i] * TUNE.tailAmp);
      }
      // the dorsal fin trails the wave, further behind again
      for (const j of DORSAL) bend(j, AX_Z, Math.sin(beat - 2.2) * 0.05);
      // and the jaw works slowly and off the beat, so it never looks like one
      // mechanism driving both. Cubed, because a fish's mouth is shut most of
      // the time and then opens.
      const gape = Math.max(0, Math.sin(u * TUNE.cross * 0.9 + state.phase * 2.3)) ** 3;
      for (const [j, way] of JAW) bend(j, AX_X, way * gape * 0.13);
      model.sync();
    }

    // Heading from the path's own tangent, so the turn at the apex comes out as
    // an arc rather than a snap — plus the yaw the beat itself puts into the
    // head, and the roll a quarter cycle behind it, which is how a fish leans
    // into its own stroke. The sway is deliberately NOT differentiated into the
    // heading any more; at this beat rate its derivative swamps the tangent and
    // the fish shakes its head instead of swimming.
    const dz = (TUNE.reach - 0.1) * Math.PI * Math.cos(Math.PI * u);
    const dx = 0.8 * state.dir;
    mesh.rotation.set(
      Math.sin(beat * 0.5) * 0.05,
      Math.atan2(dx, dz) + Math.sin(beat) * 0.06,
      -Math.cos(beat) * 0.09);
    // Dissolve by DEPTH, not by how far through the crossing it is. Fog is a
    // property of the water between it and the camera, so distance is the
    // honest input, and it is also the robust one: however the path is retuned
    // the fish cannot appear anywhere but far away. Gone by z = -1.1h, still
    // travelling to -1.5h, so it is invisible for a good while before the
    // mesh is switched off. The clock term is only a backstop for the very
    // ends, in case the path is ever changed to start closer.
    const deep = Math.min(1, Math.max(0, (-z / h - TUNE.fadeStart) / TUNE.fadeSpan));
    state.fade = Math.max(deep, 1 - Math.min(1, Math.min(u, 1 - u) / 0.10));
    mesh.updateMatrixWorld();
  }

  // A word rather than a single key, because every single key is already a
  // shortcut — and the word has to avoid them too. `fish` was the obvious
  // choice and the wrong one: F is fullscreen and H hides the interface, so
  // typing it summoned the fish behind a hidden interface in fullscreen.
  // s/w/i/m are all unbound (Space O R X B C P Q H F are not).
  const WORD = 'swim';
  let typed = '';
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-WORD.length);
    if (typed === WORD && !mesh.visible) begin();
  });

  return { update, begin, state };
}
