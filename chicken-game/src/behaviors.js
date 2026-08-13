import * as THREE from 'three';
import { clamp, pick, rand, TAU } from './util.js';

// Every strange thing a chicken can decide to do lives here. Each behavior:
//   weight   relative chance of being picked (0 = only ever forced)
//   weird    counts toward the "weird moments" tally and uses the chicken's
//            personal weirdness multiplier
//   dur      [min,max] seconds before the next decision
//   cooldown seconds (plus up to as many again) before it can repeat
//   icon     thought bubble shown on entry. There is no text anywhere in
//            this game, so the bubble plus the pose IS the explanation —
//            if a behavior cannot be read without one, it needs a better pose.
//   can      optional gate; enter/update/exit drive the chicken
//   next     chain to this behavior when the timer expires naturally;
//            may be a function (c, w) => name. Use this instead of calling
//            c.force() from exit(), which would re-enter the exit handler.

const AREA = 4.1;

function randomPoint(w, margin = 0.4) {
  return new THREE.Vector3(
    rand(w.rng, -(AREA - margin), AREA - margin), 0,
    rand(w.rng, -(AREA - margin), AREA - margin));
}

// Everyone except this chicken, Bertha, and anyone off the floor.
function others(c, w) {
  return w.chickens.filter((o) => o !== c && !o.big && !o.perch && !o.riding);
}

// Where the audience is, as far as the simulation is concerned.
//
// This deliberately is NOT the local camera. Every viewer has their own
// camera moving at their own framerate, so reading it here would both steer
// each client's chickens differently and make "she is watching you" a
// different claim on every screen. Watchers are shared world state, updated
// by WATCH events. With several viewers the target is picked by distance with
// the id as tiebreak, so everyone sees the same hen fixated on the same
// person.
function watcher(c, w) {
  const list = w.watchers;
  if (!list.length) return w.audienceFallback;
  let best = list[0];
  let bestD = best.pos.distanceToSquared(c.pos);
  for (let i = 1; i < list.length; i++) {
    const d = list[i].pos.distanceToSquared(c.pos);
    if (d < bestD || (d === bestD && list[i].id < best.id)) { best = list[i]; bestD = d; }
  }
  return best.pos;
}

function nearest(c, w, maxDist = 99) {
  let best = null, bestD = maxDist;
  for (const o of others(c, w)) {
    const d = o.pos.distanceTo(c.pos);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

// Send a chicken flying away from a point, clamped inside the coop.
function knockBack(c, fromPos, dist, height, dur) {
  const away = new THREE.Vector3(c.pos.x - fromPos.x, 0, c.pos.z - fromPos.z);
  if (away.lengthSq() < 0.01) away.set(1, 0, 0);
  away.normalize().multiplyScalar(dist).add(c.pos);
  away.y = 0;
  away.x = clamp(away.x, -AREA, AREA);
  away.z = clamp(away.z, -AREA, AREA);
  c.startHop(away, height, dur);
}

export const BEHAVIORS = {

  // ---- ordinary chicken business (the baseline the weirdness pops out of) --

  wander: {
    weight: 3.0, dur: [4, 9],
    enter(c, w) { c.walkTo(randomPoint(w), rand(w.rng, 0.55, 0.85)); },
    update(c, w, dt) {
      if (c.arrived()) {
        if (w.rng() < 0.4) c.doPeck();
        if (w.rng() < 0.03) c.walkTo(randomPoint(w), rand(w.rng, 0.55, 0.85));
      }
    },
  },

  peckAround: {
    weight: 2.2, dur: [3, 7],
    enter(c) { c.stop(); },
    update(c, w, dt) {
      if (w.rng() < dt * 2.2) c.doPeck();
      if (w.rng() < dt * 0.5) c.yaw += rand(w.rng, -0.9, 0.9);
    },
  },

  eat: {
    weight: 1.2, dur: [5, 9], icon: 'grain',
    enter(c, w) {
      const f = w.coop.feeder;
      const a = rand(w.rng, 0, TAU);
      c.bhv.data.spot = new THREE.Vector3(f.x + Math.sin(a) * 0.62, 0, f.z + Math.cos(a) * 0.62);
      c.walkTo(c.bhv.data.spot, 0.8);
    },
    update(c, w, dt) {
      if (c.arrived(0.25)) {
        c.facePoint(w.coop.feeder, dt);
        if (w.rng() < dt * 2.5) { c.doPeck(0.35); w.audio.cluck(0.9); }
      }
    },
  },

  drink: {
    weight: 0.8, dur: [5, 8], icon: 'drop',
    enter(c, w) {
      const s = w.coop.water;
      c.walkTo(new THREE.Vector3(s.x, 0, s.z + 0.5), 0.75);
      c.bhv.data.phase = 0;
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!c.arrived(0.22)) return;
      c.facePoint(w.coop.water, dt);
      d.phase += dt;
      // sip down… then tip the head way back. Physically necessary, always funny.
      c.neckPitchT = (d.phase % 1.6) < 0.7 ? 0.9 : -0.55;
    },
    exit(c) { c.neckPitchT = 0; },
  },

  // ---- the weird stuff ----------------------------------------------------

  zoomies: {
    weight: 0.9, weird: true, dur: [3, 6], icon: 'star',
    enter(c, w) { c.flapT = 0.5; c.walkTo(randomPoint(w), 2.6); },
    update(c, w, dt) {
      if (c.arrived(0.5)) c.walkTo(randomPoint(w), 2.6);
      if (w.rng() < dt * 1.5) w.fx.feather(c.pos, c.color);
      // Running this fast, sometimes the legs simply stop cooperating.
      if (w.rng() < dt * 0.08) c.force('bonk', { trip: true });
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  stareWall: {
    weight: 0.7, weird: true, dur: [6, 14], icon: 'dots',
    enter(c, w) {
      const walls = [
        new THREE.Vector3(rand(w.rng, -3, 3), 0, -AREA), new THREE.Vector3(rand(w.rng, -3, 3), 0, AREA),
        new THREE.Vector3(-AREA, 0, rand(w.rng, -3, 3)), new THREE.Vector3(AREA, 0, rand(w.rng, -3, 3)),
      ];
      const spot = pick(w.rng, walls);
      c.bhv.data.wall = spot.clone().multiplyScalar(1.4);
      c.walkTo(spot, 0.9);
    },
    update(c, w, dt) {
      if (c.arrived(0.3)) {
        c.facePoint(c.bhv.data.wall, dt, 3);
        // Every so often she remembers she is still doing this.
        if (w.rng() < dt * 0.12) c.showEmote('dots', 2);
      }
    },
  },

  stareYou: {
    weight: 0.8, weird: true, dur: [5, 11], icon: 'eye',
    enter(c, w) {
      c.stop();
      c.bhv.data.creep = w.rng() < 0.35; // sometimes she comes closer. slowly.
    },
    update(c, w, dt) {
      const cam = watcher(c, w);
      c.facePoint(cam, dt, 4);
      c.headTiltT = Math.sin(w.time * 0.7) * 0.45;
      if (c.bhv.data.creep && cam.distanceTo(c.pos) > 1.4) {
        c.pos.x += Math.sin(c.yaw) * 0.14 * dt;
        c.pos.z += Math.cos(c.yaw) * 0.14 * dt;
        c.gaitAmp = 0.25; c.gait += dt * 2.5; // slow, deliberate steps
        if (!c.bhv.data.said && c.bhv.t > 2.5) {
          c.bhv.data.said = true;
          c.showEmote('eye', 2.6);
        }
      }
    },
    exit(c) { c.headTiltT = 0; },
  },

  statue: {
    weight: 0.6, weird: true, dur: [4, 9], icon: 'dots',
    enter(c, w) {
      // Freeze mid-stride: legs scissored, head half-raised.
      c.stop();
      c.legs[0].rotation.x = 0.5; c.legs[1].rotation.x = -0.5;
      c.neck.rotation.x = -0.15;
      c.frozen = true;
    },
    exit(c) { c.frozen = false; },
  },

  spin: {
    weight: 0.5, weird: true, dur: [4.5, 6.5], icon: 'spiral',
    enter(c, w) {
      c.stop();
      c.bhv.data.dir = w.rng() < 0.5 ? -1 : 1;
      c.bhv.data.spinT = c.bhv.dur * 0.6;
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (c.bhv.t < d.spinT) {
        c.yaw += d.dir * dt * (4 + c.bhv.t * 2);
        c.gaitAmp = 1; c.gait += dt * 10;
      } else {
        // Dizzy aftermath: a decaying wobble and a head full of stars.
        if (!d.saidDizzy) { d.saidDizzy = true; c.showEmote('dizzy', 2.6); }
        const left = 1 - (c.bhv.t - d.spinT) / (c.bhv.dur - d.spinT);
        c.bodyRoll = Math.sin(w.time * 9) * 0.25 * Math.max(0, left);
      }
    },
    exit(c) { c.bodyRoll = 0; },
  },

  moonwalk: {
    weight: 0.5, weird: true, dur: [3, 5], icon: 'note',
    enter(c, w) { c.stop(); },
    update(c, w, dt) {
      // Legs animate a confident walk while the body glides backwards.
      c.gaitAmp = 1; c.gait += dt * 7;
      c.pos.x -= Math.sin(c.yaw) * 0.45 * dt;
      c.pos.z -= Math.cos(c.yaw) * 0.45 * dt;
      c.neckPitchT = -0.2;
    },
    exit(c) { c.gaitAmp = 0; c.neckPitchT = 0; },
  },

  sidle: {
    weight: 0.4, weird: true, dur: [3, 5.5], icon: 'eye',
    enter(c, w) { c.stop(); c.bhv.data.dir = w.rng() < 0.5 ? -1 : 1; },
    update(c, w, dt) {
      c.facePoint(watcher(c, w), dt, 3);
      const strafeYaw = c.yaw + (Math.PI / 2) * c.bhv.data.dir;
      c.pos.x += Math.sin(strafeYaw) * 0.4 * dt;
      c.pos.z += Math.cos(strafeYaw) * 0.4 * dt;
      c.gaitAmp = 0.7; c.gait += dt * 8;
    },
  },

  jumpScare: {
    weight: 0.6, weird: true, dur: [2.5, 4],
    enter(c, w) { c.stop(); c.bhv.data.at = rand(w.rng, 0.4, 1.6); c.bhv.data.done = false; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.done && c.bhv.t >= d.at) {
        d.done = true;
        c.startHop(c.pos, rand(w.rng, 0.45, 0.7), 0.5);
        c.showEmote('bang', 1.8);
        w.audio.squawk(1.3);
        w.fx.feather(c.pos, c.color);
      }
      if (d.done && !c.hop) c.headYawT = Math.sin(w.time * 6) * 0.7; // frantic look-around
    },
    exit(c) { c.headYawT = 0; },
  },

  investigate: {
    weight: 0.9, weird: true, dur: [5, 9], icon: 'question',
    enter(c, w) {
      const p = c.pos.clone();
      p.x = clamp(p.x + rand(w.rng, -1.5, 1.5), -AREA, AREA);
      p.z = clamp(p.z + rand(w.rng, -1.5, 1.5), -AREA, AREA);
      c.bhv.data.spot = p;
      c.walkTo(p, 0.7);
    },
    update(c, w, dt) {
      if (!c.arrived(0.35)) return;
      c.stop();
      c.neckPitchT = 0.55;
      c.headTiltT = Math.sin(w.time * 1.8) > 0 ? 0.5 : -0.5; // tilt… other tilt…
      if (w.rng() < dt * 0.8) c.doPeck();
    },
    exit(c) { c.neckPitchT = 0; c.headTiltT = 0; },
  },

  chase: {
    weight: 0.7, weird: true, dur: [4, 7], cooldown: 12, icon: 'anger',
    can(c, w) { return others(c, w).some((o) => o.bhv.name !== 'panic'); },
    enter(c, w) {
      const victims = others(c, w).filter((o) => o.bhv.name !== 'panic');
      const v = pick(w.rng, victims);
      c.bhv.data.victim = v;
      v.force('flee', { from: c });
      c.flapT = 0.35;
    },
    update(c, w, dt) {
      const v = c.bhv.data.victim;
      c.walkTo(v.pos, 2.1);
      if (c.pos.distanceTo(v.pos) < 0.45) {
        // Caught her, and immediately has no idea what to do about it.
        c.showEmote('question', 2.2);
        v.force('wander');
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  flee: {
    weight: 0, dur: [3, 5], icon: 'bang',
    enter(c, w) { c.flapT = 0.6; w.audio.squawk(0.9); },
    update(c, w, dt) {
      const from = c.bhv.data.from;
      if (from) {
        const away = c.pos.clone().sub(from.pos);
        away.y = 0;
        if (away.lengthSq() < 0.01) away.set(1, 0, 0);
        away.normalize().multiplyScalar(2.5).add(c.pos);
        away.x = clamp(away.x + rand(w.rng, -1, 1), -AREA, AREA);
        away.z = clamp(away.z + rand(w.rng, -1, 1), -AREA, AREA);
        c.walkTo(away, 2.3);
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  roost: {
    weight: 0.8, dur: [10, 22], cooldown: 20,
    enter(c, w) {
      const bar = pick(w.rng, w.coop.roosts);
      const x = rand(w.rng, bar.x0 + 0.3, bar.x1 - 0.3);
      c.bhv.data.bar = bar;
      c.bhv.data.spot = new THREE.Vector3(x, bar.y, bar.z);
      c.bhv.data.phase = 'approach';
      c.walkTo(new THREE.Vector3(x, 0, bar.z + 0.7), 0.9);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'approach' && c.arrived(0.3)) {
        d.phase = 'mount';
        c.startHop(d.spot, 0.45, 0.65);
        w.audio.cluck(1.1);
      } else if (d.phase === 'mount' && !c.hop) {
        d.phase = 'perched';
        c.perch = d.bar;
        c.sitT = 0.55;
      } else if (d.phase === 'perched') {
        c.facePoint(new THREE.Vector3(0, c.pos.y, 0), dt, 1.5);
        // Occasional wobble; rare comedy fall.
        if (w.rng() < dt * 0.25) c.bodyRoll = rand(w.rng, -0.16, 0.16);
        c.bodyRoll *= Math.max(0, 1 - dt * 3);
        if (w.rng() < dt * 0.025) {
          c.showEmote('bang', 1.6);
          c.comeDown();
          c.force('bonk', { fell: true });
        }
      }
    },
    exit(c, w) {
      c.bodyRoll = 0;
      if (c.perch) { c.comeDown(); }
    },
  },

  dustBath: {
    weight: 0.8, weird: true, dur: [7, 12], cooldown: 25, icon: 'star',
    enter(c, w) { c.walkTo(randomPoint(w, 1.2), 0.8); c.bhv.data.bathing = false; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.bathing) {
        if (c.arrived(0.3)) { d.bathing = true; c.stop(); c.sitT = 1; }
        return;
      }
      c.bodyRoll = Math.sin(w.time * 5.2) * 0.35;
      c.flapT = 0.3 + Math.sin(w.time * 8) * 0.2;
      if (w.rng() < dt * 2.2) w.fx.puff(c.pos, 0x9a7f5c);
    },
    exit(c, w) {
      c.sitT = 0; c.bodyRoll = 0; c.flapT = 0;
      // stand up and shake it all off
      w.fx.puff(c.pos, 0x9a7f5c);
      w.fx.feather(c.pos, c.color);
    },
  },

  // No icon: the rising Zs already say it, and a bubble on top doubles up.
  sleep: {
    weight: 0.7, weird: true, dur: [9, 16], cooldown: 30,
    enter(c, w) {
      c.stop();
      c.bhv.data.standing = w.rng() < 0.5;
      if (!c.bhv.data.standing) c.sitT = 1;
      c.neckPitchT = 0.5;
      c.headYawT = 1.9; // head tucked back toward the wing
      c.lidT = 1;
      c.bhv.data.z = 0;
    },
    update(c, w, dt) {
      c.bhv.data.z -= dt;
      if (c.bhv.data.z <= 0) {
        c.bhv.data.z = 1.5;
        w.fx.zzz(c.pos.clone().add(new THREE.Vector3(0, 0.75, 0)));
      }
    },
    exit(c) { c.sitT = 0; c.neckPitchT = 0; c.headYawT = 0; c.lidT = 0; },
  },

  layEgg: {
    weight: 0.55, dur: [9, 12], cooldown: 55, icon: 'egg',
    enter(c, w) {
      const useNest = w.rng() < 0.55;
      c.bhv.data.phase = 'go';
      if (useNest) {
        c.bhv.data.nest = pick(w.rng, w.coop.nests);
        c.walkTo(c.bhv.data.nest, 0.9);
      } else {
        c.bhv.data.nest = null;
        c.stop(); // right here is fine, apparently
      }
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'go') {
        if (!d.nest || c.arrived(0.25)) {
          d.phase = 'squat';
          d.squatT = 0;
          c.stop();
          c.sitT = 1;
        }
      } else if (d.phase === 'squat') {
        d.squatT += dt;
        c.bodyRoll = Math.sin(w.time * 18) * 0.05; // concentration shiver
        if (d.squatT > 2.8) {
          d.phase = 'proud';
          c.bodyRoll = 0;
          c.sitT = 0;
          const eggPos = c.pos.clone().sub(new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)).multiplyScalar(0.25));
          w.spawnEgg(eggPos);
          w.audio.fanfare();
          c.flapT = 0.9;
          c.showEmote('star', 2.6);
        }
      } else if (d.phase === 'proud') {
        c.flapT = Math.max(0, c.flapT - dt * 1.5);
        if (!c.move || c.arrived()) c.walkTo(randomPoint(w), 1.1); // victory strut
        c.gait += dt * 4; // extra strut in the step
      }
    },
    exit(c) { c.sitT = 0; c.bodyRoll = 0; c.flapT = 0; },
  },

  // The full ceremony, no egg. Comedy is timing.
  phantomEgg: {
    weight: 0.5, weird: true, dur: [8, 10], cooldown: 45, icon: 'egg',
    enter(c, w) { c.stop(); c.sitT = 1; c.bhv.data.phase = 'strain'; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'strain') {
        c.bodyRoll = Math.sin(w.time * 20) * 0.06;
        c.flapT = Math.min(0.5, c.bhv.t * 0.2);
        if (c.bhv.t > 3.4) {
          d.phase = 'nothing';
          c.bodyRoll = 0; c.flapT = 0; c.sitT = 0;
          c.showEmote('question', 3.2); // where is it
        }
      } else {
        // stares back at the spot where the egg should be
        c.neckPitchT = 0.6;
        c.headTiltT = Math.sin(w.time * 1.4) * 0.4;
      }
    },
    exit(c) { c.sitT = 0; c.bodyRoll = 0; c.flapT = 0; c.neckPitchT = 0; c.headTiltT = 0; },
  },

  // A full-body sneeze with recoil.
  sneeze: {
    weight: 0.5, weird: true, dur: [4.5, 6], cooldown: 30,
    enter(c, w) { c.stop(); c.bhv.data.done = false; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.done) {
        // wind-up: head rears further and further back
        c.neckPitchT = -0.35 - Math.min(0.55, c.bhv.t * 0.42);
        if (c.bhv.t > 1.6) {
          d.done = true;
          c.neckPitchT = 0.8;
          c.showEmote('bang', 1.6);
          w.audio.sneeze();
          w.shake(0.05);
          for (let i = 0; i < 5; i++) w.fx.feather(c.pos, c.color);
          w.fx.puff(c.pos.clone().add(
            new THREE.Vector3(Math.sin(c.yaw) * 0.3, 0.1, Math.cos(c.yaw) * 0.3)), 0xd8cbb0);
          knockBack(c, c.pos.clone().add(
            new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw))), 0.85, 0.18, 0.42);
        }
      } else if (c.bhv.t > 2.6) {
        c.neckPitchT = 0; // composure, eventually
      }
    },
    exit(c) { c.neckPitchT = 0; },
  },

  // Knocked flat: wall, another chicken, a trip, or falling off the roost.
  bonk: {
    weight: 0, weird: true, chained: true, dur: [3.4, 4.4], icon: 'dizzy',
    enter(c, w) {
      c.stop();
      c.frozen = false;
      c.fallT = 1;
      c.legKick = 1;
      c.lidT = 0;
      w.audio.bonk();
      w.audio.squawk(1.45);
      w.shake(0.07);
      w.incident();
      for (let i = 0; i < 4; i++) w.fx.feather(c.pos, c.color);
      w.fx.puff(c.pos, 0x9a7f5c);
      const d = c.bhv.data;
      if (d.from) knockBack(c, d.from.pos, 0.55, 0.16, 0.34);
      else if (d.wall) {
        // bounce back into the room
        knockBack(c, c.pos.clone().multiplyScalar(1.6), 0.5, 0.16, 0.34);
      } else if (d.trip) {
        // carried forward by her own momentum, face first
        const fwd = c.pos.clone().add(
          new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)).multiplyScalar(0.6));
        fwd.x = clamp(fwd.x, -AREA, AREA); fwd.z = clamp(fwd.z, -AREA, AREA);
        c.startHop(fwd, 0.1, 0.3);
      }
    },
    update(c, w, dt) {
      // Legs bicycle for a while, then she works out which way is up.
      if (c.bhv.t > c.bhv.dur - 1.2) {
        c.fallT = 0;
        c.legKick = Math.max(0, c.legKick - dt * 2);
      } else {
        c.legKick = 1;
        c.bodyRoll = Math.sin(w.time * 6) * 0.08;
      }
    },
    exit(c) { c.fallT = 0; c.legKick = 0; c.bodyRoll = 0; },
  },

  panic: {
    weight: 0.15, weird: true, dur: [2.5, 5], cooldown: 18, icon: 'bang',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.flapT = 1;
      if (c.bhv.data.short) c.bhv.dur = 1.8;
      w.audio.squawk(1);
      w.incident();
      c.walkTo(randomPoint(w), 3.0);
      c.bhv.data.infect = 0;
    },
    update(c, w, dt) {
      if (c.arrived(0.6)) c.walkTo(randomPoint(w), 3.0);
      if (w.rng() < dt * 2.5) w.fx.feather(c.pos, c.color);
      if (w.rng() < dt * 1.2) w.audio.squawk(rand(w.rng, 0.8, 1.4));
      // Panic is contagious.
      c.bhv.data.infect -= dt;
      if (c.bhv.data.infect <= 0) {
        c.bhv.data.infect = 0.3;
        for (const o of others(c, w)) {
          if (o.bhv.name === 'panic') continue;
          if (o.pos.distanceTo(c.pos) < 2.0 && w.rng() < 0.3) o.force('panic');
        }
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  seedRush: {
    weight: 0, dur: [8, 14], icon: 'grain',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.flapT = 0.4;
    },
    update(c, w, dt) {
      const patch = c.bhv.data.patch;
      if (!patch || patch.count <= 0) { c.bhv.t = c.bhv.dur; return; }
      c.flapT = Math.max(0, c.flapT - dt);
      const spot = patch.spotFor(c);
      if (c.pos.distanceTo(spot) > 0.3) c.walkTo(spot, 2.0);
      else {
        c.stop();
        c.facePoint(patch.pos, dt);
        if (w.rng() < dt * 3 && c.doPeck()) {
          patch.eat();
          w.audio.cluck(rand(w.rng, 0.8, 1.2));
          if (patch.count <= 0) c.showEmote('question', 2.4);
        }
      }
    },
    exit(c) { c.stop(); c.flapT = 0; },
  },

  // ---- social nonsense ----------------------------------------------------

  conga: {
    weight: 0.55, weird: true, dur: [10, 16], cooldown: 40, icon: 'note',
    can(c, w) { return others(c, w).length >= 2; },
    enter(c, w) {
      const pool = others(c, w).filter((o) => o.bhv.name !== 'panic' && o.bhv.name !== 'conga');
      const n = Math.min(pool.length, 2 + Math.floor(w.rng() * 3));
      for (let i = 0; i < n; i++) {
        const f = pool.splice(Math.floor(w.rng() * pool.length), 1)[0];
        f.force('congaFollow', { leader: c, slot: i + 1 });
      }
      c.bhv.data.count = n;
      c.walkTo(randomPoint(w), 0.95);
    },
    update(c, w, dt) {
      if (c.arrived(0.4)) c.walkTo(randomPoint(w), 0.95);
      if (w.rng() < dt * 0.25) c.showEmote('note', 2);
    },
    exit(c) { c.stop(); },
  },

  congaFollow: {
    weight: 0, dur: [10, 16], icon: 'note',
    update(c, w, dt) {
      const { leader, slot } = c.bhv.data;
      if (!leader || leader.bhv.name !== 'conga') { c.bhv.t = c.bhv.dur; return; }
      // Aim at a point directly behind the leader, one slot back per follower.
      const back = new THREE.Vector3(-Math.sin(leader.yaw), 0, -Math.cos(leader.yaw))
        .multiplyScalar(0.52 * slot).add(leader.pos);
      back.y = 0;
      c.walkTo(back, 1.15);
    },
    exit(c) { c.stop(); },
  },

  standoff: {
    weight: 0.6, weird: true, dur: [6, 9], cooldown: 30, icon: 'anger',
    can(c, w) { return !!nearest(c, w, 3.0); },
    enter(c, w) {
      const rival = nearest(c, w, 3.0);
      if (!rival) { c.bhv.t = c.bhv.dur; return; }
      c.bhv.data.rival = rival;
      rival.force('standoffB', { rival: c });
      c.stop();
    },
    update(c, w, dt) {
      const r = c.bhv.data.rival;
      if (!r) return;
      c.facePoint(r.pos, dt, 4);
      // slow menacing head bob, building
      c.neckPitchT = Math.sin(w.time * 3.5) * 0.35;
      if (c.pos.distanceTo(r.pos) > 0.8) c.walkTo(r.pos, 0.5);
      else c.stop();
    },
    exit(c, w) {
      c.neckPitchT = 0;
      const r = c.bhv.data.rival;
      if (r && w.rng() < 0.7) r.force('flee', { from: c });
    },
  },

  standoffB: {
    weight: 0, dur: [6, 9], icon: 'anger',
    update(c, w, dt) {
      const r = c.bhv.data.rival;
      if (!r || r.bhv.name !== 'standoff') { c.bhv.t = c.bhv.dur; return; }
      c.facePoint(r.pos, dt, 4);
      c.neckPitchT = Math.sin(w.time * 3.5 + 1.6) * 0.35;
      c.stop();
    },
    exit(c) { c.neckPitchT = 0; },
  },

  tailPeck: {
    weight: 0.55, weird: true, dur: [7, 10], cooldown: 28, icon: 'star',
    can(c, w) { return !!nearest(c, w, 4.5); },
    enter(c, w) {
      const v = nearest(c, w, 4.5);
      if (!v) { c.bhv.t = c.bhv.dur; return; }
      c.bhv.data.victim = v;
      c.bhv.data.phase = 'sneak';
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      const v = d.victim;
      if (!v) return;
      if (d.phase === 'sneak') {
        // creep up on the tail end
        const behind = new THREE.Vector3(-Math.sin(v.yaw), 0, -Math.cos(v.yaw))
          .multiplyScalar(0.42).add(v.pos);
        behind.y = 0;
        c.walkTo(behind, 0.85);
        if (c.pos.distanceTo(v.pos) < 0.55) {
          d.phase = 'innocent';
          c.stop();
          c.doPeck(0.25);
          v.startHop(v.pos.clone(), 0.3, 0.38);
          v.showEmote('bang', 1.8);
          w.audio.squawk(1.35);
          w.fx.feather(v.pos, v.color);
          w.incident();
          if (w.rng() < 0.5) v.force('flee', { from: c });
        }
      } else {
        // whistling, looking anywhere else
        c.neckPitchT = -0.4;
        c.headYawT = Math.sin(w.time * 1.1) * 0.8;
      }
    },
    exit(c) { c.neckPitchT = 0; c.headYawT = 0; c.stop(); },
  },

  gawk: {
    weight: 0.6, weird: true, dur: [8, 13], cooldown: 35, icon: 'question',
    enter(c, w) {
      const spot = randomPoint(w, 1.0);
      c.bhv.data.spot = spot;
      c.walkTo(spot, 1.0);
      // Curiosity is contagious: pull in a couple of onlookers.
      const pool = others(c, w).filter((o) => o.bhv.name !== 'panic');
      const n = Math.min(pool.length, 1 + Math.floor(w.rng() * 3));
      for (let i = 0; i < n; i++) {
        const o = pool.splice(Math.floor(w.rng() * pool.length), 1)[0];
        o.force('gawkJoin', { spot });
      }
    },
    update(c, w, dt) {
      if (!c.arrived(0.4)) return;
      c.stop();
      c.facePoint(c.bhv.data.spot, dt, 3);
      c.neckPitchT = 0.5;
      if (w.rng() < dt * 0.6) c.doPeck();
    },
    exit(c, w) {
      c.neckPitchT = 0;
      if (w.rng() < 0.7) c.showEmote('dots', 2.4); // nothing was there
    },
  },

  gawkJoin: {
    weight: 0, dur: [6, 10], icon: 'question',
    enter(c, w) {
      // A snapshot restores behaviors by name with no data, so enter() must
      // never assume the caller supplied any.
      const s = c.bhv.data.spot ?? (c.bhv.data.spot = c.pos.clone());
      const a = rand(w.rng, 0, TAU);
      c.walkTo(new THREE.Vector3(s.x + Math.sin(a) * 0.75, 0, s.z + Math.cos(a) * 0.75), 1.2);
    },
    update(c, w, dt) {
      if (!c.arrived(0.35)) return;
      c.stop();
      c.facePoint(c.bhv.data.spot, dt, 3);
      c.neckPitchT = 0.45;
      c.headTiltT = Math.sin(w.time * 1.3 + c.pos.x) * 0.35;
    },
    exit(c) { c.neckPitchT = 0; c.headTiltT = 0; },
  },

  copycat: {
    weight: 0.45, weird: true, dur: [1, 1.5], cooldown: 30, icon: 'eye',
    can(c, w) { return !!nearest(c, w, 3.5); },
    enter(c, w) {
      const m = nearest(c, w, 3.5);
      // Copy only solo behaviors; the multi-actor ones need their own casting.
      const SOLO = ['peckAround', 'stareWall', 'statue', 'spin', 'moonwalk', 'sidle',
        'zoomies', 'investigate', 'dustBath', 'oneLeg', 'existential', 'stareYou', 'sneeze'];
      if (m && SOLO.includes(m.bhv.name)) c.bhv.data.copy = m.bhv.name;
    },
    // Chain into the copied behavior once the beat lands.
    next: (c) => c.bhv.data.copy ?? 'peckAround',
  },

  existential: {
    weight: 0.5, weird: true, dur: [7, 12], icon: 'spiral',
    enter(c, w) { c.stop(); },
    update(c, w, dt) {
      c.neckPitchT = -0.95; // head all the way back, staring up
      c.headTiltT = Math.sin(w.time * 0.5) * 0.18;
      if (w.rng() < dt * 0.15) c.showEmote('spiral', 2.4);
    },
    exit(c) { c.neckPitchT = 0; c.headTiltT = 0; },
  },

  oneLeg: {
    weight: 0.5, weird: true, dur: [6, 11], icon: 'star',
    enter(c, w) { c.stop(); c.legTuckT = 1; },
    update(c, w, dt) {
      // the wobble of someone regretting a commitment
      c.bodyRoll = Math.sin(w.time * 2.6) * 0.09 + Math.sin(w.time * 7.3) * 0.03;
      if (c.bhv.t > c.bhv.dur - 1 && w.rng() < dt * 3) c.legTuckT = 0;
    },
    exit(c) { c.legTuckT = 0; c.bodyRoll = 0; },
  },

  scream: {
    weight: 0.4, weird: true, dur: [3, 4.5], cooldown: 25, icon: 'bang',
    enter(c, w) {
      c.stop();
      c.neckPitchT = -0.7;
      w.audio.squawk(0.75);
      w.audio.squawk(1.5);
      w.incident();
      w.fx.feather(c.pos, c.color);
      for (const o of others(c, w)) {
        if (o.pos.distanceTo(c.pos) < 3.5 && o.bhv.name !== 'panic' && w.rng() < 0.75) {
          o.force('lookAt', { at: c });
        }
      }
    },
    exit(c) { c.neckPitchT = 0; },
  },

  lookAt: {
    weight: 0, dur: [1.8, 3], icon: 'question',
    enter(c) { c.stop(); },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.at) c.facePoint(d.at.pos, dt, 6);
      c.headTiltT = 0.3;
      if (d.up) c.neckPitchT = -0.85; // something is happening on the ceiling
    },
    exit(c) { c.headTiltT = 0; c.neckPitchT = 0; },
  },

  flightAttempt: {
    weight: 0.55, weird: true, dur: [5, 7], cooldown: 30, icon: 'wing',
    enter(c, w) { c.stop(); c.bhv.data.phase = 'wind'; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'wind') {
        // furious flapping, going nowhere
        c.flapT = Math.min(1, c.bhv.t * 0.9);
        c.gaitAmp = 0.5; c.gait += dt * 12;
        if (c.bhv.t > 1.8) {
          d.phase = 'launch';
          const to = c.pos.clone().add(
            new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)).multiplyScalar(1.3));
          to.x = clamp(to.x, -AREA, AREA); to.z = clamp(to.z, -AREA, AREA);
          c.startHop(to, 0.55, 0.75); // the full extent of chicken aviation
          w.audio.squawk(1.1);
          for (let i = 0; i < 3; i++) w.fx.feather(c.pos, c.color);
        }
      } else if (d.phase === 'launch' && !c.hop) {
        d.phase = 'landed';
        c.flapT = 0;
        c.bodyRoll = 0.35;
        c.showEmote('dizzy', 2.4);
        w.fx.puff(c.pos, 0x9a7f5c);
        w.audio.bonk();
      } else if (d.phase === 'landed') {
        c.bodyRoll *= Math.max(0, 1 - dt * 2.5);
        c.neckPitchT = 0.3; // dazed
      }
    },
    exit(c) { c.flapT = 0; c.bodyRoll = 0; c.neckPitchT = 0; },
  },

  // ---- behaviors that revolve around the matriarch ------------------------

  worship: {
    weight: 0.5, weird: true, dur: [8, 13], cooldown: 40, icon: 'heart',
    can(c, w) { return !!w.bertha; },
    enter(c, w) {
      const b = w.bertha;
      const a = rand(w.rng, 0, TAU);
      c.walkTo(new THREE.Vector3(b.pos.x + Math.sin(a) * 1.15, 0, b.pos.z + Math.cos(a) * 1.15), 0.9);
    },
    update(c, w, dt) {
      if (!c.arrived(0.4)) return;
      c.stop();
      c.facePoint(w.bertha.pos, dt, 3);
      // slow, reverent bowing
      c.neckPitchT = Math.sin(w.time * 1.2) > 0 ? 0.85 : -0.1;
      if (w.rng() < dt * 0.2) c.showEmote('heart', 2);
    },
    exit(c) { c.neckPitchT = 0; },
  },

  rideBertha: {
    weight: 0.7, weird: true, dur: [12, 22], cooldown: 50, icon: 'crown',
    can(c, w) {
      const b = w.bertha;
      return !!b && b.sit > 0.6 && b.riders.length < 2 && !c.riding && !c.perch;
    },
    enter(c, w) {
      const b = w.bertha;
      c.bhv.data.phase = 'approach';
      c.walkTo(new THREE.Vector3(b.pos.x, 0, b.pos.z + 1.05), 0.9);
    },
    update(c, w, dt) {
      const b = w.bertha;
      const d = c.bhv.data;
      if (!b) { c.bhv.t = c.bhv.dur; return; }
      if (d.phase === 'approach') {
        if (c.arrived(0.4)) {
          if (b.sit < 0.5) { c.bhv.t = c.bhv.dur; return; } // she got up first
          d.phase = 'mount';
          c.startHop(new THREE.Vector3(b.pos.x, b.rideHeight, b.pos.z), 0.55, 0.6);
        }
      } else if (d.phase === 'mount' && !c.hop) {
        // She may have stood up during the half-second of the leap.
        if (b.sit < 0.55) {
          c.showEmote('bang', 1.8);
          c.force('bonk', { from: b });
          return;
        }
        d.phase = 'riding';
        c.mount(b, new THREE.Vector3(rand(w.rng, -0.22, 0.22), 0, rand(w.rng, -0.28, 0.28)));
        c.sitT = 0.35;
        c.showEmote('crown', 2.8);
        w.audio.cluck(1.2);
      } else if (d.phase === 'riding') {
        if (!c.riding) { c.bhv.t = c.bhv.dur; return; } // bucked off
        if (w.rng() < dt * 0.5) c.doPeck();
        if (w.rng() < dt * 0.3) c.headYawT = rand(w.rng, -0.9, 0.9);
        if (w.rng() < dt * 0.15) c.showEmote('crown', 2);
      }
    },
    exit(c, w) {
      c.sitT = 0; c.headYawT = 0;
      if (c.riding) c.dismount();
    },
  },
};

// ---- Big Bertha ------------------------------------------------------------
// She runs a separate table: mostly asleep, occasionally catastrophic.

export const BIG_BEHAVIORS = {

  bigSleep: {
    weight: 5, dur: [18, 32],   // her rising Zs carry this; see `sleep`
    enter(c, w) {
      c.stop();
      c.sitT = 1; c.lidT = 1;
      c.neckPitchT = 0.4;
      c.headYawT = 1.7;   // head tucked into the wing
      c.bhv.data.z = 0;
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      d.z -= dt;
      if (d.z <= 0) {
        d.z = rand(w.rng, 1.9, 2.8);
        w.fx.zzz(c.pos.clone().add(new THREE.Vector3(0, 1.45, 0)), 0.34);
        w.audio.snore();
        // Each snore visibly moves the air in front of her.
        w.fx.puff(c.pos.clone().add(new THREE.Vector3(0, 0.55, 0)), 0xc4b393);
      }
      // dream twitches
      if (w.rng() < dt * 0.3) { c.bodyRoll = rand(w.rng, -0.05, 0.05); c.flapT = 0.12; }
      c.bodyRoll *= Math.max(0, 1 - dt * 2);
      c.flapT *= Math.max(0, 1 - dt * 2);
    },
    exit(c) { c.neckPitchT = 0; c.headYawT = 0; c.flapT = 0; c.bodyRoll = 0; },
  },

  // She stirs, mutters, and does not wake. Pure anticlimax.
  bigStir: {
    weight: 1.4, dur: [5, 8], icon: 'zzz',
    enter(c, w) {
      c.lidT = 0.75;
      c.headYawT = 0.6;
      w.audio.snore(0.7);
      // Everyone nearby stops what they're doing to check.
      for (const o of w.chickens) {
        if (o.big || o.riding) continue;
        if (o.pos.distanceTo(c.pos) < 3 && w.rng() < 0.5) o.force('lookAt', { at: c });
      }
    },
    update(c, w, dt) { c.bodyRoll = Math.sin(w.time * 1.4) * 0.07; },
    exit(c) { c.lidT = 1; c.headYawT = 1.7; c.bodyRoll = 0; },
    next: 'bigSleep',
  },

  // The slow, terrible business of standing up.
  bigRise: {
    weight: 1.5, weird: true, dur: [4.5, 5.5], cooldown: 30, icon: 'bang',
    enter(c, w) {
      c.buckOff();          // any passengers are launched immediately
      c.lidT = 0.1;
      c.headYawT = 0;
      c.neckPitchT = -0.25;
      w.audio.berthaGroan();
      w.incident();
      // The whole coop notices.
      for (const o of w.chickens) {
        if (o.big) continue;
        if (w.rng() < 0.7) o.force('lookAt', { at: c });
      }
    },
    update(c, w, dt) {
      // She unfolds over several seconds; the sit value is the whole animation.
      c.sitT = Math.max(0, 1 - c.bhv.t / 3.2);
    },
    // Half the time she stands, reconsiders, and lies back down.
    next: (c, w) => (w.rng() < 0.62 ? 'reckoning' : 'bigShrug'),
  },

  bigShrug: {
    weight: 0, dur: [3.5, 5], icon: 'dots',
    enter(c) { c.stop(); },
    update(c, w, dt) { c.facePoint(watcher(c, w), dt, 0.7); },
    next: 'bigSettle',
  },

  // THE RECKONING. She crosses the coop and everything gets out of the way.
  reckoning: {
    weight: 0, weird: true, chained: true, dur: [14, 20], icon: 'anger',
    enter(c, w) {
      w.audio.berthaCall();
      w.incident();
      c.lidT = 0.1;
      c.bhv.data.legs = 2 + Math.floor(w.rng() * 2);
      c.walkTo(randomPoint(w, 1.3), 0.42);
    },
    update(c, w, dt) {
      // Anything in her path decides it has business elsewhere.
      for (const o of w.chickens) {
        if (o.big || o.riding) continue;
        const d = o.pos.distanceTo(c.pos);
        if (d < 2.4 && o.bhv.name !== 'flee' && o.bhv.name !== 'panic' && w.rng() < dt * 3) {
          o.force('flee', { from: c });
        }
      }
      if (c.arrived(0.45)) {
        if (--c.bhv.data.legs > 0) c.walkTo(randomPoint(w, 1.3), 0.42);
        else c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.stop(); },
    next: 'bigSettle',
  },

  // Lowering herself back down, with feeling.
  bigSettle: {
    weight: 0, dur: [4, 5], icon: 'zzz',
    enter(c) { c.stop(); },
    update(c, w, dt) {
      c.sitT = Math.min(1, c.bhv.t / 2.6);
      c.lidT = Math.min(1, 0.2 + c.bhv.t / 3);
    },
    next: 'bigSleep',
  },

  // She eats. There is nothing left for anyone else.
  bigEat: {
    weight: 1.1, dur: [16, 22], cooldown: 60, icon: 'grain',
    enter(c, w) {
      c.buckOff();
      c.lidT = 0.2;
      c.sitT = 0;
      c.bhv.data.phase = 'rise';
      w.incident();
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      const f = w.coop.feeder;
      if (d.phase === 'rise') {
        c.sitT = 0;
        if (c.bhv.t > 2.2) { d.phase = 'walk'; c.walkTo(new THREE.Vector3(f.x - 0.9, 0, f.z - 0.5), 0.42); }
      } else if (d.phase === 'walk') {
        // Chickens at the feeder clear out.
        for (const o of w.chickens) {
          if (o.big || o.riding) continue;
          if (o.pos.distanceTo(c.pos) < 2.0 && o.bhv.name !== 'flee' && w.rng() < dt * 2.5) {
            o.force('flee', { from: c });
          }
        }
        if (c.arrived(0.5)) d.phase = 'eat';
      } else {
        c.facePoint(f, dt, 1.2);
        if (w.rng() < dt * 2) { c.doPeck(0.55); w.audio.cluck(0.55); }
      }
    },
    next: 'bigSettle',
  },

  // Being looked at, and looking back.
  bigStare: {
    weight: 0.9, weird: true, dur: [9, 14], cooldown: 45, icon: 'eye',
    enter(c, w) { c.stop(); c.lidT = 0.05; },
    update(c, w, dt) {
      c.facePoint(watcher(c, w), dt, 0.9); // she turns very, very slowly
      c.headTiltT = Math.sin(w.time * 0.35) * 0.22;
      if (w.rng() < dt * 0.12) c.showEmote('eye', 2.6);
    },
    exit(c) { c.headTiltT = 0; },
    next: 'bigSettle',
  },

  // An earthquake with feathers.
  bigDustBath: {
    weight: 0.8, weird: true, dur: [12, 16], cooldown: 70, icon: 'star',
    enter(c, w) {
      c.buckOff();
      c.stop();
      c.sitT = 1;
      c.lidT = 0.4;
      w.incident();
    },
    update(c, w, dt) {
      c.bodyRoll = Math.sin(w.time * 3.1) * 0.42;
      c.flapT = 0.4 + Math.sin(w.time * 5) * 0.25;
      if (w.rng() < dt * 7) w.fx.puff(c.pos, 0x9a7f5c);
      if (w.rng() < dt * 3) w.shake(0.09);
      // Everyone gives her a wide berth.
      for (const o of w.chickens) {
        if (o.big || o.riding) continue;
        if (o.pos.distanceTo(c.pos) < 1.9 && o.bhv.name !== 'flee' && w.rng() < dt * 2) {
          o.force('flee', { from: c });
        }
      }
    },
    exit(c, w) {
      c.bodyRoll = 0; c.flapT = 0;
      for (let i = 0; i < 5; i++) w.fx.puff(c.pos, 0x9a7f5c);
      w.fx.feather(c.pos, c.color);
      w.shake(0.2);
    },
    // Sometimes she rolls a little too far and cannot get back over.
    next: (c, w) => (w.rng() < 0.45 ? 'bigStuck' : 'bigSettle'),
  },

  // Flat on her back, legs in the air. The single funniest thing in the coop.
  bigStuck: {
    weight: 0, weird: true, chained: true, dur: [10, 14], icon: 'dizzy',
    enter(c, w) {
      c.buckOff();
      c.stop();
      c.fallT = 1;
      c.legKick = 1;
      c.sitT = 1;
      c.lidT = 0.1;
      w.audio.berthaGroan(0.75);
      w.shake(0.28);
      w.incident();
      for (let i = 0; i < 6; i++) w.fx.puff(c.pos, 0x9a7f5c);
      // The entire coop comes to look at this.
      for (const o of w.chickens) {
        if (o.big) continue;
        if (w.rng() < 0.85) o.force('gawkJoin', { spot: c.pos.clone() });
      }
    },
    update(c, w, dt) {
      c.legKick = 1;
      c.bodyRoll = Math.sin(w.time * 3.4) * 0.12;
      if (w.rng() < dt * 1.2) w.fx.puff(c.pos, 0x9a7f5c);
      if (w.rng() < dt * 0.5) w.audio.berthaGroan(rand(w.rng, 0.7, 1.05));
      if (w.rng() < dt * 0.25) c.showEmote('dizzy', 2.4);
    },
    exit(c, w) {
      // She rights herself all at once, and everyone regrets watching.
      c.fallT = 0; c.legKick = 0; c.bodyRoll = 0;
      w.shake(0.34);
      w.audio.berthaCall();
      for (let i = 0; i < 8; i++) w.fx.puff(c.pos, 0x9a7f5c);
      for (const o of w.chickens) {
        if (!o.big && o.pos.distanceTo(c.pos) < 3.2) o.force('flee', { from: c });
      }
    },
    next: 'bigSettle',
  },

  // Seeds are worth getting up for.
  bigSeedRush: {
    weight: 0, weird: true, chained: true, dur: [16, 22], icon: 'grain',
    enter(c, w) {
      c.buckOff();
      c.sitT = 0;
      c.lidT = 0.2;
      c.bhv.data.phase = 'rise';
      w.audio.berthaGroan();
      w.incident();
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      const patch = d.patch;
      if (!patch || patch.count <= 0) { c.bhv.t = c.bhv.dur; return; }
      if (d.phase === 'rise') {
        if (c.bhv.t > 2.4) d.phase = 'walk';
        return;
      }
      const spot = new THREE.Vector3(patch.pos.x, 0, patch.pos.z + 0.75);
      if (c.pos.distanceTo(spot) > 0.5) {
        c.walkTo(spot, 0.45);
        for (const o of w.chickens) {
          if (o.big || o.riding) continue;
          if (o.pos.distanceTo(c.pos) < 1.8 && o.bhv.name !== 'flee' && w.rng() < dt * 2.5) {
            o.force('flee', { from: c });
          }
        }
      } else {
        c.stop();
        c.facePoint(patch.pos, dt, 1.5);
        if (w.rng() < dt * 4) {
          c.doPeck();
          patch.eat(); patch.eat(); // she takes two at a time
          w.audio.cluck(0.5);
        }
      }
    },
    next: 'bigSettle',
  },

  // You clicked her.
  bigGlare: {
    weight: 0, dur: [5, 7], icon: 'anger',
    enter(c, w) {
      c.lidT = 0.35;
      w.audio.berthaGroan(0.8);
    },
    update(c, w, dt) { c.facePoint(watcher(c, w), dt, 0.8); },
    // Poke her enough and she gets up. That is on you.
    next: (c, w) => (w.rng() < 0.35 ? 'bigRise' : 'bigSleep'),
  },
};

// Behaviors that only make sense with a partner or a target that a snapshot
// does not carry — a follower needs its leader, a rush needs its seed patch.
// A client restoring from a snapshot puts these chickens back on `wander`
// instead and lets them pick again; positions stay correct either way, which
// is what the snapshot is really for.
const NEEDS_CONTEXT = new Set(['congaFollow', 'standoffB', 'gawkJoin', 'seedRush', 'lookAt']);
export const isResumable = (name) => !NEEDS_CONTEXT.has(name);

// ---- state machine plumbing ------------------------------------------------

const TABLES = { normal: BEHAVIORS, big: BIG_BEHAVIORS };
const PICKABLE = {
  normal: Object.entries(BEHAVIORS).filter(([, d]) => d.weight > 0),
  big: Object.entries(BIG_BEHAVIORS).filter(([, d]) => d.weight > 0),
};

// Bertha cannot be startled, seeded, or chased like an ordinary chicken;
// requests aimed at her get translated or dropped.
const BIG_ALIASES = {
  seedRush: 'bigSeedRush', wander: 'bigSettle',
  panic: null, flee: null, lookAt: null, bonk: null, gawkJoin: null,
};

// Guards against a behavior's exit() handler triggering another transition,
// which would re-enter that same exit(). Chain with `next` instead.
function runExit(c, w) {
  if (c._inExit) return;
  c._inExit = true;
  try { c.bhv.def?.exit?.(c, w); } finally { c._inExit = false; }
}

export function pickBehavior(c, w) {
  // A finished behavior can hand off to a specific successor.
  const chain = c.bhv.def?.next;
  if (chain) {
    const name = typeof chain === 'function' ? chain(c, w) : chain;
    if (name) return forceBehavior(c, w, name, {});
  }

  const table = TABLES[c.table] ?? BEHAVIORS;
  let total = 0;
  const bag = [];
  for (const [name, def] of PICKABLE[c.table] ?? PICKABLE.normal) {
    if (def.can && !def.can(c, w)) continue;
    if ((c.cooldowns[name] ?? 0) > w.time) continue;
    let weight = def.weight * (def.weird ? c.weirdMul : 1);
    if (name === c.bhv.lastName) weight *= 0.25; // variety, but repeats stay possible
    total += weight;
    bag.push([name, def, weight]);
  }
  let roll = w.rng() * total;
  for (const [name, def, weight] of bag) {
    roll -= weight;
    if (roll <= 0) return enterBehavior(c, w, name, def, {});
  }
  const fallback = c.big ? 'bigSleep' : 'wander';
  return enterBehavior(c, w, fallback, table[fallback], {});
}

export function forceBehavior(c, w, name, data = {}) {
  if (c.big) {
    if (name in BIG_ALIASES) name = BIG_ALIASES[name];
    if (!name) return c.bhv;      // she is unbothered
  }
  const def = (TABLES[c.table] ?? BEHAVIORS)[name] ?? BEHAVIORS[name];
  if (!def) return c.bhv;
  c.frozen = false;
  runExit(c, w);
  return enterBehavior(c, w, name, def, data, true);
}

function enterBehavior(c, w, name, def, data, forced = false) {
  const prev = c.bhv;
  if (!forced) runExit(c, w);
  c.bhv = {
    name, def, t: 0, data,
    dur: rand(w.rng, def.dur[0], def.dur[1]),
    lastName: prev.name,
  };
  if (def.cooldown) c.cooldowns[name] = w.time + def.cooldown + rand(w.rng, 0, def.cooldown);
  // Count spontaneous weirdness only, or a panic cascade inflates the tally
  // by one per infected chicken. `chained` opts a forced behavior back in.
  if (def.weird && (!forced || def.chained)) w.ui.addWeird();
  if (def.icon) c.showEmote(def.icon);
  def.enter?.(c, w);
  return c.bhv;
}
