// The harpoon — a rope between two stubborn masses, and everything that
// follows from taking the other end personally.
//
// The physics is one spring-damper, applied honestly to both ends:
//
//   T = K * stretch + C * max(0, separation rate)        tension, never push
//
// The boat receives T as an acceleration at the BOW: the horizontal part
// becomes drift the keel has to kill (boatController.js consumes ctx.tow),
// the off-axis part swings her nose toward the pull and heels her over, and
// any downward component shortens her freeboard — which is how a sounding
// leviathan pulls the foredeck green. The creature receives -T scaled by a
// mass ratio, folded into its own steering (the 'hooked' phase in
// monster.js), so a hard pull visibly bends its path without ever puppeting
// it.
//
// Consequences run on accumulators rather than instants, because a rope
// yanks in spikes and a capsize should be earned over seconds, not lost to
// one frame of bad luck:
//
//   rollEnergy   grows while the lateral pull exceeds what the keel damps —
//                past ROLL_LIMIT she goes over (the roll is scripted, the
//                trigger is not)
//   sinkEnergy   grows while the bow is being held under; past DUNK_LIMIT
//                the line is torn off the cleat and she pops back up
//   snapT        grows while tension rides above 92% of TMAX; past SNAP_S
//                the line parts — the mercy valve that keeps an unwinnable
//                pull from being a permanent state
//   strain       the creature's exhaustion, 0..1. It climbs while the line
//                is loaded and the player pulls AGAINST the run, which is
//                the whole game: hold on, keep the line singing but not
//                snapping, and the animal tires, rises, and finally slips
//                the hook. Nobody dies; everybody has a story.

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- the fire envelope -------------------------------------------------------
const RANGE = 60;            // m, boat to creature, for the call-to-action
const DEPTH_MAX = 15;        // deeper than this the spear cannot reach
const COOLDOWN = 2.4;        // s between throws
// --- the spear ---------------------------------------------------------------
const SPEAR_V = 40;          // m/s off the bow
const SPEAR_G = 4.5;         // m/s^2 of drop; a harpoon is not a bullet
const FLIGHT_MAX = 1.9;      // s before it is called a miss
// --- the rope ----------------------------------------------------------------
const REST_MIN = 13, REST_MAX = 42;
const K = 0.95;              // accel per metre of stretch, boat side
const CDAMP = 0.5;           // accel per m/s of separation rate
const LEV_MASS = 26;         // how much harder the creature is to shift
const YAW_K = 0.14;          // nose-toward-the-pull, rad/s per accel unit
const HEEL_K = 0.115;        // heel per lateral accel unit
const SINK_K = 0.16;         // freeboard lost per downward accel unit
// --- the consequences --------------------------------------------------------
const STRAIN_UP = 0.030;     // /s at full load and full opposition
const CUT_HOLD_S = 0.55;
const ROLL_DECAY = 0.5, SINK_DECAY = 0.45;

export function createHarpoon(opts = {}) {
  const { ctx, scene, monster, camera } = opts;
  const water = opts.water || (() => null);
  const burst = opts.burst || (() => {});
  const audio = opts.audio || null;

  // Everything a HUD or a harness could want, in one bag.
  const state = {
    available: false,
    flight: false,
    tethered: false,
    tension: 0,
    strain: 0,
    distance: 0,
    msg: '',
    msgT: 9,
    cutHold: 0,
    capsizing: false,
  };

  // Tunables the debug harness may lower to reach the rare outcomes quickly.
  const tune = {
    TMAX: 14,                // accel units at which the line is at its limit
    SNAP_S: 1.5,             // s above 92% before it parts
    ROLL_LIMIT: 1.35,        // rollEnergy that capsizes
    DUNK_LIMIT: 1.6,         // sinkEnergy that drags the bow under
  };

  // --- visuals ---------------------------------------------------------------
  // Built once, hidden by uniforms (never .visible — the boot warm-up has to
  // draw these so their pipelines compile before the first throw).

  const group = new THREE.Group();
  group.name = 'harpoon';

  // Opacity rides uniforms so the materials are never touched after build:
  // both the rope and the spear exist (alpha 0) from boot, which is what lets
  // warmUpClock compile their pipelines before the first throw.
  const uSpearAlpha = uniform(0);
  const uLineAlpha = uniform(0);
  {

    // The spear: a shaft, a tip, a small tail vane. Kit-bash, like the boat.
    const spear = new THREE.Group();
    spear.name = 'harpoon-spear';
    const matWood = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color().setHex(0x6E4E30, THREE.SRGBColorSpace),
      roughness: 0.8, metalness: 0.0, transparent: true, fog: true,
    });
    matWood.opacityNode = uSpearAlpha;
    const matIron = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color().setHex(0x3A3C42, THREE.SRGBColorSpace),
      roughness: 0.45, metalness: 0.35, transparent: true, fog: true,
    });
    matIron.opacityNode = uSpearAlpha;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.3, 7), matWood);
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.55, 7), matIron);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -1.35;
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.34), matWood);
    vane.position.z = 1.05;
    spear.add(shaft, tip, vane);
    spear.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    group.add(spear);

    // The rope: a chain of thin instanced boxes laid along a sagging curve.
    // Instanced so the per-frame cost is one matrix write per segment and no
    // geometry ever rebuilds.
    const SEGS = 26;
    // Dark hawser, one hand thick. 5.5 cm was honest and invisible: at the
    // thirty-metre distances this line actually spans, honest is sub-pixel,
    // and a rope you cannot see is a mechanic you cannot read. Dark, because
    // the background is sunlit water — a pale line vanished into it.
    const matRope = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color().setHex(0x4E3A22, THREE.SRGBColorSpace),
      roughness: 0.92, metalness: 0.0, transparent: true, fog: true,
    });
    matRope.opacityNode = uLineAlpha;
    const rope = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.11, 1), matRope, SEGS);
    rope.name = 'harpoon-rope';
    rope.frustumCulled = false;
    group.add(rope);

    setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
    applyWaterClip(group);
    scene.add(group);

    // --- scratch --------------------------------------------------------------
    const _bow = new THREE.Vector3();
    const _anchor = new THREE.Vector3();
    const _dir = new THREE.Vector3();
    const _vB = new THREE.Vector3();
    const _rel = new THREE.Vector3();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _m = new THREE.Matrix4();
    const _s = new THREE.Vector3(1, 1, 1);
    const _mid = new THREE.Vector3();
    const _a = new THREE.Vector3();
    const _b2 = new THREE.Vector3();
    const _fwd = new THREE.Vector3();
    const _Z = new THREE.Vector3(0, 0, 1);

    // --- state ----------------------------------------------------------------
    let cooldown = 0;
    let flightT = 0;
    const spearPos = new THREE.Vector3();
    const spearVel = new THREE.Vector3();
    let rest = 20;
    let attachAlong = 0;     // metres along the creature's axis, + toward head
    let snapT = 0;
    let rollEnergy = 0;
    let sinkEnergy = 0;
    let strain = 0;
    let groanAt = 0.33;
    let cutHeld = false;
    let capsizeT = -1;       // <0 idle, else seconds into the sequence
    let capsizeSide = 1;
    let capsizeSink = false; // the dunk variant
    const tow = { fx: 0, fz: 0, yaw: 0, heel: 0, trim: 0, sink: 0, brake: 0 };
    let tensionSmooth = 0;

    const hook = monster && monster.hook;
    const mstate = monster && monster.state;

    function setMsg(text) { state.msg = text; state.msgT = 0; }

    function bowPoint(out) {
      const b = ctx.boat;
      return out.set(
        b.position.x + b.forward.x * 2.3,
        b.position.y + 0.55,
        b.position.z + b.forward.z * 2.3,
      );
    }

    /** The rope's far end: a point on the creature's spine near the strike. */
    function anchorPoint(out) {
      const p = mstate.position;
      const v = hook.velocity;
      _fwd.copy(v);
      _fwd.y *= 0.4;
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
      _fwd.normalize();
      return out.set(
        p.x + _fwd.x * attachAlong,
        p.y + 1.2 * hook.scale,
        p.z + _fwd.z * attachAlong,
      );
    }

    function release(reason) {
      if (!state.tethered) return;
      state.tethered = false;
      snapT = 0;
      rollEnergy = 0;
      sinkEnergy = 0;
      tensionSmooth = 0;
      state.tension = 0;
      cooldown = COOLDOWN;
      hook?.release?.();
      audio?.setLineTension?.(0);
      if (reason) setMsg(reason);
    }

    function attachNow() {
      if (!hook || !mstate) return false;
      if (state.tethered || !hook.engage()) return false;
      state.tethered = true;
      state.flight = false;
      strain = 0;
      groanAt = 0.33;
      snapT = 0;
      rollEnergy = 0;
      sinkEnergy = 0;
      bowPoint(_bow);
      rest = clamp(_bow.distanceTo(mstate.position) * 0.96, REST_MIN, REST_MAX);
      audio?.cue?.('harpoonHit');
      burst(mstate.position.x, mstate.position.z, 30, 1.2);
      const w = water();
      if (w?.disturb) w.disturb(mstate.position.x, mstate.position.z, 1.6, 6.5);
      return true;
    }

    function beginCapsize(side, dunk) {
      if (capsizeT >= 0) return;
      capsizeT = 0;
      capsizeSide = side >= 0 ? 1 : -1;
      capsizeSink = !!dunk;
      state.capsizing = true;
      ctx.harpoonHold = true;
      release(dunk
        ? 'She sounds hard - the bow goes under and the line tears free!'
        : 'She rolls you clean over! The line is gone.');
      audio?.cue?.('lineSnap');
    }

    // The scripted part of a capsize: trigger is physics, theatre is not.
    // Roll her over ~1s, wallow ~1s, right herself with a damped wobble ~2s.
    function stepCapsize(dt) {
      capsizeT += dt;
      const b = ctx.boat;
      const t = capsizeT;
      tow.fx = 0; tow.fz = 0; tow.yaw = 0; tow.brake = 1.2; tow.trim = 0;
      if (t < 1.0) {
        const k = t / 1.0;
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9) * k * k * (3 - 2 * k);
        tow.sink = capsizeSink ? 2.2 * k : 0.6 * k;
      } else if (t < 2.0) {
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9);
        tow.sink = capsizeSink ? 2.2 : 0.6;
        if (((t * 5) | 0) !== (((t - dt) * 5) | 0)) {
          burst(b.position.x, b.position.z, 22, 1.4);
          const w = water();
          if (w?.disturb) w.disturb(b.position.x, b.position.z, 1.8, 5.5);
        }
      } else if (t < 4.2) {
        const k = t - 2.0;
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9) * Math.exp(-k * 2.1) * Math.cos(k * 4.6);
        tow.sink = Math.max(0, (capsizeSink ? 2.2 : 0.6) * (1 - k / 0.8));
      } else {
        capsizeT = -1;
        state.capsizing = false;
        ctx.harpoonHold = false;
        tow.heel = 0; tow.sink = 0; tow.brake = 0;
        ctx.tow = null;
        return;
      }
      ctx.tow = tow;
    }

    function fire() {
      if (!state.available) return;
      state.flight = true;
      flightT = 0;
      cooldown = COOLDOWN;
      bowPoint(spearPos);
      // Lead the target: aim at where the spine will be when the spear
      // arrives, which is what makes hitting a moving animal feel fair.
      const d = spearPos.distanceTo(mstate.position);
      const tFly = d / SPEAR_V;
      _a.copy(mstate.position).addScaledVector(hook.velocity, tFly);
      _dir.copy(_a).sub(spearPos);
      // A touch of loft to counter the drop over the flight.
      _dir.y += 0.5 * SPEAR_G * tFly * tFly;
      _dir.normalize();
      spearVel.copy(_dir).multiplyScalar(SPEAR_V);
      audio?.cue?.('harpoonFire');
    }

    function stepFlight(dt) {
      flightT += dt;
      spearVel.y -= SPEAR_G * dt;
      spearPos.addScaledVector(spearVel, dt);

      // Strike test: distance to the creature's spine, treated as a capsule
      // from mid-tail to nose.
      const p = mstate.position;
      _fwd.copy(hook.velocity).setY(0);
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
      _fwd.normalize();
      const L = 12 * hook.scale;
      _a.copy(p).addScaledVector(_fwd, L);        // toward the head
      _b2.copy(p).addScaledVector(_fwd, -L);      // down the tail
      _rel.copy(_b2).sub(_a);
      const tSeg = clamp(_p.copy(spearPos).sub(_a).dot(_rel) / _rel.lengthSq(), 0, 1);
      _p.copy(_a).addScaledVector(_rel, tSeg);
      const hitR = 3.4 * hook.scale;
      if (spearPos.distanceToSquared(_p) < hitR * hitR && mstate.phase !== 'breach') {
        attachAlong = clamp((0.5 - tSeg) * 2 * L, -9 * hook.scale, 11 * hook.scale);
        state.flight = false;
        if (!attachNow()) { setMsg('The spear glances off.'); }
        return;
      }
      const w = water();
      const surf = w?.sampleHeight ? w.sampleHeight(spearPos.x, spearPos.z, ctx.time) : 0;
      if (spearPos.y < surf - 0.4 || flightT > FLIGHT_MAX) {
        state.flight = false;
        setMsg('Missed - the spear slips under.');
        burst(spearPos.x, spearPos.z, 10, 0.6);
        if (w?.disturb) w.disturb(spearPos.x, spearPos.z, 0.8, 2.2);
      }
    }

    function stepTether(dt) {
      const b = ctx.boat;
      bowPoint(_bow);
      anchorPoint(_anchor);
      _dir.copy(_anchor).sub(_bow);
      const dist = _dir.length();
      state.distance = dist;
      if (dist > 1e-4) _dir.multiplyScalar(1 / dist);

      const stretch = dist - rest;
      let T = 0;
      if (stretch > 0) {
        _vB.copy(b.forward).multiplyScalar(b.speed);
        if (b.towDrift) { _vB.x += b.towDrift.x; _vB.z += b.towDrift.y; }
        _rel.copy(hook.velocity).sub(_vB);
        const sep = _rel.dot(_dir);
        T = K * stretch + CDAMP * Math.max(0, sep);
        T = Math.min(T, tune.TMAX * 1.15);
      }
      const t01 = T / tune.TMAX;
      state.tension = t01;
      tensionSmooth += (t01 - tensionSmooth) * Math.min(1, dt * 6);
      audio?.setLineTension?.(tensionSmooth);

      if (T > 0) {
        // Boat end. Horizontal force feeds the drift; the lateral share
        // swings the bow and heels her; a downward rope steals freeboard.
        const ax = _dir.x * T, ay = _dir.y * T, az = _dir.z * T;
        const lateral = ax * b.right.x + az * b.right.z;
        const along = ax * b.forward.x + az * b.forward.z;
        tow.fx = ax;
        tow.fz = az;
        tow.yaw = clamp(lateral * YAW_K, -0.85, 0.85);
        tow.heel = clamp(-lateral * HEEL_K, -1.7, 1.7);
        tow.trim = clamp(Math.min(0, ay) * 0.03 - Math.max(0, along) * 0.006, -0.42, 0.05);
        tow.sink = Math.max(0, -ay) * SINK_K;
        tow.brake = along < 0 ? Math.min(1.4, -along * 0.1) : 0;
        ctx.tow = tow;

        // Creature end: equal, opposite, and divided by a lot of leviathan.
        hook.pull(-ax / LEV_MASS * 8, -ay / LEV_MASS * 6, -az / LEV_MASS * 8);

        // Strain: the line has to be LOADED and the player pulling AGAINST
        // the run. Idling on a slack line teaches it nothing.
        const oppose = clamp(-(_vB.x * _dir.x + _vB.z * _dir.z) / 6, 0, 1);
        if (t01 > 0.4) {
          strain = clamp(strain + dt * (0.005 + STRAIN_UP * t01 * (0.35 + 0.65 * oppose)), 0, 1);
        }
      } else {
        ctx.tow = null;
        strain = clamp(strain - dt * 0.012, 0, 1);
      }
      state.strain = strain;
      hook.strain(strain);

      if (strain >= groanAt) {
        groanAt += 0.33;
        audio?.cue?.('levGroan');
      }

      // The win: she tires, and slips the hook on her own terms.
      if (strain >= 1) {
        burst(mstate.position.x, mstate.position.z, 34, 1.3);
        audio?.cue?.('victory');
        release('She tires, rolls, and slips the line. What a fish story.');
        return;
      }

      // The snap: sustained overload parts the line.
      if (t01 > 0.92) snapT += dt;
      else snapT = Math.max(0, snapT - dt * 2);
      if (snapT > tune.SNAP_S) {
        audio?.cue?.('lineSnap');
        bowPoint(_p);
        burst(_p.x, _p.z, 14, 0.9);
        release('The line parts with a crack!');
        return;
      }

      // The consequences that make her dangerous. Both accumulators charge
      // while the pull exceeds what the hull shrugs off, and drain whenever
      // the line goes quiet — a capsize is EARNED over seconds of being
      // hauled beam-on, never lost to one frame.
      rollEnergy = Math.max(0, rollEnergy
        + dt * (T > 0 ? Math.abs(tow.heel) - 0.62 : -ROLL_DECAY));
      sinkEnergy = Math.max(0, sinkEnergy
        + dt * (T > 0 ? tow.sink - 0.7 : -SINK_DECAY));
      if (rollEnergy > tune.ROLL_LIMIT) { beginCapsize(-Math.sign(tow.heel || 1), false); return; }
      if (sinkEnergy > tune.DUNK_LIMIT) { beginCapsize(1, true); return; }

      // The cut.
      if (cutHeld) {
        state.cutHold = clamp(state.cutHold + dt / CUT_HOLD_S, 0, 1);
        if (state.cutHold >= 1) {
          state.cutHold = 0;
          release('You cut the line free.');
        }
      } else {
        state.cutHold = Math.max(0, state.cutHold - dt * 3);
      }
    }

    // --- the visuals, every frame ----------------------------------------------
    function layoutRope(alphaTarget) {
      uLineAlpha.value += (alphaTarget - uLineAlpha.value) * 0.3;
      if (uLineAlpha.value < 0.02) {
        if (rope.count !== 0) { rope.count = 0; }
        return;
      }
      rope.count = SEGS;
      bowPoint(_bow);
      if (state.tethered) anchorPoint(_anchor);
      else _anchor.copy(spearPos);
      // Sag: a slack line hangs, a loaded one straightens and hums.
      const dist = _bow.distanceTo(_anchor);
      const slack = Math.max(0, rest - dist);
      const sag = state.tethered
        ? clamp(0.25 + slack * 0.45 - state.tension * 2.2, 0.06, 5)
        : 0.4;
      _mid.copy(_bow).add(_anchor).multiplyScalar(0.5);
      _mid.y -= sag;
      let px = _bow.x, py = _bow.y, pz = _bow.z;
      for (let i = 0; i < SEGS; i++) {
        const t2 = (i + 1) / SEGS;
        const it = 1 - t2;
        const qx = _bow.x * it * it + _mid.x * 2 * it * t2 + _anchor.x * t2 * t2;
        const qy = _bow.y * it * it + _mid.y * 2 * it * t2 + _anchor.y * t2 * t2;
        const qz = _bow.z * it * it + _mid.z * 2 * it * t2 + _anchor.z * t2 * t2;
        _a.set(qx - px, qy - py, qz - pz);
        const len = Math.max(_a.length(), 1e-4);
        _p.set((qx + px) / 2, (qy + py) / 2, (qz + pz) / 2);
        _q.setFromUnitVectors(_Z, _a.multiplyScalar(1 / len));
        _s.set(1, 1, len);
        _m.compose(_p, _q, _s);
        rope.setMatrixAt(i, _m);
        px = qx; py = qy; pz = qz;
      }
      rope.instanceMatrix.needsUpdate = true;
    }

    function layoutSpear() {
      const want = state.flight || state.tethered ? 1 : 0;
      uSpearAlpha.value += (want - uSpearAlpha.value) * 0.35;
      if (state.flight) {
        spear.position.copy(spearPos);
        _a.copy(spearVel).normalize();
        _q.setFromUnitVectors(_Z, _a);
        spear.quaternion.copy(_q);
        spear.quaternion.multiply(_q2FlipCache);
      } else if (state.tethered) {
        anchorPoint(_p);
        spear.position.copy(_p);
        bowPoint(_a);
        _a.sub(_p).normalize();
        _q.setFromUnitVectors(_Z, _a);
        spear.quaternion.copy(_q);
      }
    }
    // The spear model points its TIP down -Z; in flight the velocity should
    // run out of the tip, so flip once here rather than re-deriving inline.
    const _q2FlipCache = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    // --- frame ------------------------------------------------------------------
    function update(c) {
      const dt = Math.min(0.05, c.dt || 0);
      state.msgT += dt;
      cooldown -= dt;

      if (capsizeT >= 0) {
        stepCapsize(dt);
        layoutRope(0);
        layoutSpear();
        return;
      }

      // Availability: near, shallow, not busy, not mid-anything.
      const busy = !!(c.fishing?.state?.active) || !!(c.shore?.state?.ashore)
        || !!c.editorHold || !!c.fishingHold;
      // Casting a lure, tying up at the quay or opening the editor mid-fight
      // all take the helm away — and a tether pulling on a boat the mooring
      // lerp is also moving is two owners of one hull. The line yields.
      if (state.tethered && busy) release('The line goes slack and drops away.');
      if (mstate && hook) {
        const d = Math.hypot(
          mstate.position.x - c.boat.position.x,
          mstate.position.z - c.boat.position.z,
        );
        state.distance = state.tethered ? state.distance : d;
        state.available = !state.tethered && !state.flight && !busy
          && cooldown <= 0 && d < RANGE && mstate.depth < DEPTH_MAX
          && mstate.phase !== 'breach';
      } else {
        state.available = false;
      }

      if (state.flight) stepFlight(dt);
      if (state.tethered) stepTether(dt);
      else if (!state.capsizing) { ctx.tow = null; audio?.setLineTension?.(0); }

      layoutRope(state.tethered ? 1 : (state.flight ? 0.9 : 0));
      layoutSpear();
    }

    // --- handle -----------------------------------------------------------------
    return {
      group: null,           // group added to scene here, not by build()
      state,
      update,
      fire,
      cut() { if (state.tethered) release('You cut the line free.'); },
      holdCut(v) { cutHeld = !!v && state.tethered; },
      applyEnv() {},
      dispose() {
        scene.remove(group);
        rope.geometry.dispose();
        matRope.dispose();
        matWood.dispose();
        matIron.dispose();
      },

      debug: {
        attach() {
          if (!mstate || state.tethered) return false;
          attachAlong = 4 * (hook?.scale || 1);
          return attachNow();
        },
        setStrain(v) { strain = clamp(v, 0, 1); },
        forceCapsize(side = 1) { beginCapsize(side, false); },
        forceDunk() { beginCapsize(1, true); },
        tune,
        get rollEnergy() { return rollEnergy; },
        get sinkEnergy() { return sinkEnergy; },
      },
    };
  }
}
