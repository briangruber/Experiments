import * as THREE from 'three';
import { clamp, pick, rand, TAU } from './util.js';
import { DOOR, bounds } from './zones.js';

// The two staging points either side of the pop-hole, as vectors.
const DOOR_IN = new THREE.Vector3(DOOR.inside.x, 0, DOOR.inside.z);
const DOOR_OUT = new THREE.Vector3(DOOR.outside.x, 0, DOOR.outside.z);

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
//   rooster  only the rooster may pick it;  hen  only hens may
//   tough    exempt from chicken-to-chicken collisions, for behaviors whose
//            whole point is a crowd converging on one spot
//   committed  cannot be interrupted by another chicken forcing a behavior on
//            her (a chase making her flee, say). Only a hawk overrides it.
//   next     chain to this behavior when the timer expires naturally;
//            may be a function (c, w) => name. Prefer this to calling
//            c.force() on yourself from exit(), which has to be deferred.

// A chicken may only ever aim at a point in her own zone — she steers in a
// straight line, so a target across the wall walks her into it.
function randomPoint(w, c, margin = 0.4) {
  const b = bounds(c.zone);
  return new THREE.Vector3(
    rand(w.rng, b.x0 + margin, b.x1 - margin), 0,
    rand(w.rng, b.z0 + margin, b.z1 - margin));
}

// Pull a point back inside the chicken's own enclosure.
function hold(c, v, margin = 0.25) {
  const b = bounds(c.zone);
  v.x = clamp(v.x, b.x0 + margin, b.x1 - margin);
  v.z = clamp(v.z, b.z0 + margin, b.z1 - margin);
  return v;
}

// Everyone except this chicken, Bertha, and anyone off the floor.
// Same zone only: a chase, a standoff or a panic must not carry through a
// solid wall to a chicken standing outside.
function others(c, w) {
  return w.chickens.filter((o) => o !== c && !o.big && !o.chick && o.active
    && !o.perch && !o.riding && o.zone === c.zone);
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
  hold(c, away);
  c.startHop(away, height, dur);
}

const FEEDING = new Set(['eat', 'peckGrass', 'seedRush', 'peckAround', 'drink']);

// Lower-ranked birds busy with food, which is what makes them worth shoving.
function pickTargets(c, w) {
  return others(c, w).filter((o) => o.rank > c.rank && FEEDING.has(o.bhv.name));
}

// Who is sitting in a given nesting box. Derived rather than bookkept: a
// reservation table would need unwinding on every way a behavior can end,
// and would be wrong the first time one of them was forgotten.
function nestOccupant(w, index, except) {
  if (index < 0) return null;
  for (const c of w.chickens) {
    if (c === except || !c.active) continue;
    if (c.bhv.data?.onNest && c.bhv.data.nestIndex === index) return c;
  }
  return null;
}

function settleOnNest(c, d) {
  d.phase = 'squat';
  d.squatT = 0;
  d.onNest = true;
  c.stop();
  c.sitT = 1;
}

// A friend of hers is squaring up to someone and nobody is backing her up
// yet. Loyalty is the whole requirement: needing a grudge against the rival
// as well made this a three-way coincidence that essentially never occurred,
// and it is not how taking someone's side works anyway.
function sidingWith(c, w) {
  for (const o of others(c, w)) {
    if (o.bhv.name !== 'standoff' && o.bhv.name !== 'standoffB') continue;
    if (o.bhv.data.backup) continue;
    const rival = o.bhv.data.rival;
    if (!rival || rival === c) continue;
    if (w.rel.get(c.index, o.index) < 0.35) continue;   // not a friend
    if (w.rel.get(c.index, rival.index) > 0.35) continue; // ...but not friends with both
    if (o.pos.distanceTo(c.pos) > 5) continue;
    return o;
  }
  return null;
}

// Perched neighbours on the same bar, near enough to be an imposition.
function perchNeighbour(c, w, radius) {
  for (const o of w.chickens) {
    if (o === c || !o.active || o.perch !== c.perch) continue;
    if (Math.abs(o.pos.x - c.pos.x) < radius) return o;
  }
  return null;
}

export const BEHAVIORS = {

  // ---- ordinary chicken business (the baseline the weirdness pops out of) --

  wander: {
    weight: 3.0, dur: [4, 9],
    enter(c, w) { c.walkTo(randomPoint(w, c), rand(w.rng, 0.55, 0.85)); },
    update(c, w, dt) {
      if (c.arrived()) {
        if (w.rng() < 0.4) c.doPeck();
        if (w.rng() < 0.03) c.walkTo(randomPoint(w, c), rand(w.rng, 0.55, 0.85));
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
    zone: 'coop', weight: 1.2, dur: [5, 9], icon: 'grain',
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
    zone: 'coop', weight: 0.8, dur: [5, 8], icon: 'drop',
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
    enter(c, w) { c.flapT = 0.5; c.walkTo(randomPoint(w, c), 2.6); },
    update(c, w, dt) {
      if (c.arrived(0.5)) c.walkTo(randomPoint(w, c), 2.6);
      if (w.rng() < dt * 1.5) w.fx.feather(c.pos, c.color);
      // Running this fast, sometimes the legs simply stop cooperating.
      if (w.rng() < dt * 0.08) c.force('bonk', { trip: true });
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  stareWall: {
    weight: 0.7, weird: true, dur: [6, 14], icon: 'dots',
    enter(c, w) {
      // Outside this is a fence, which is just as absorbing.
      const b = bounds(c.zone);
      const mx = rand(w.rng, b.x0 + 0.8, b.x1 - 0.8);
      const mz = rand(w.rng, b.z0 + 0.8, b.z1 - 0.8);
      const spot = pick(w.rng, [
        new THREE.Vector3(mx, 0, b.z0 + 0.25), new THREE.Vector3(mx, 0, b.z1 - 0.25),
        new THREE.Vector3(b.x0 + 0.25, 0, mz), new THREE.Vector3(b.x1 - 0.25, 0, mz),
      ]);
      const mid = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
      c.bhv.data.wall = spot.clone().sub(mid).multiplyScalar(1.4).add(mid);
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
      p.x += rand(w.rng, -1.5, 1.5);
      p.z += rand(w.rng, -1.5, 1.5);
      c.bhv.data.spot = hold(c, p);
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
      const v = c.bhv.data.victim ?? pick(w.rng, victims);
      c.bhv.data.victim = v;
      // noFlee: the target is doing something more interesting than fleeing
      // (a worm victory lap), and cancelling it would defeat the point.
      if (!c.bhv.data.noFlee) v.force('flee', { from: c });
      c.flapT = 0.35;
    },
    update(c, w, dt) {
      const v = c.bhv.data.victim;
      c.walkTo(v.pos, 2.1);
      // A grace period, or a pursuer who started shoulder to shoulder with
      // her target "catches" it on the first tick and there is no chase.
      if (c.bhv.t > 1.1 && c.pos.distanceTo(v.pos) < 0.45) {
        // Caught her, and immediately has no idea what to do about it.
        c.showEmote('question', 2.2);
        if (!c.bhv.data.noFlee) v.force('wander');
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
        away.x += rand(w.rng, -1, 1);
        away.z += rand(w.rng, -1, 1);
        c.walkTo(hold(c, away), 2.3);
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  roost: {
    zone: 'coop', weight: 0.8, dur: [10, 22], cooldown: 20,
    // Once up for the night she stays up; the duration is stretched on entry.
    nightDur: [55, 90],
    enter(c, w) {
      if (w.phase === 'night' || w.phase === 'dusk') {
        c.bhv.dur = rand(w.rng, 55, 90);   // settled in for the night
      }
      // Rank decides altitude. Top birds take the high bar, and they take it
      // by turning up and shoving — see the jostling below.
      const bars = w.coop.roosts;
      const senior = c.rank <= Math.ceil(c.rankOf / 2);
      const bar = w.rng() < 0.78
        ? bars[senior ? bars.length - 1 : 0]
        : pick(w.rng, bars);
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

        // Settling down for the night is not a peaceful business — but who
        // gets shoved depends on how she feels about them, not only on rank.
        // A bird she is on good terms with keeps her place, and a night spent
        // shoulder to shoulder deepens it. That is the flywheel: the roost is
        // where the alliances get made as well as the feuds.
        //
        // These two were separate before, and the shove was the likelier of
        // them, so roosting next to somebody reliably produced a grudge and
        // bonds never got off the ground.
        const mate = perchNeighbour(c, w, 0.8);
        if (mate && !mate.bhv.def?.committed) {
          const feel = w.rel.get(c.index, mate.index);
          if (c.rank < mate.rank && feel < 0.3 && w.rng() < dt * 0.4) {
            const spot = mate.pos.x;
            mate.showEmote('bang', 1.6);
            mate.comeDown();
            mate.force('bonk', { fell: true });
            w.rel.slight(c.index, mate.index, 'shovedOffRoost');
            w.director?.beat('shovedOffRoost', mate, c);
            w.audio.squawk(rand(w.rng, 0.8, 1.2));
            w.fx.feather(c.pos, mate.color);
            // Shuffle along into the vacancy.
            c.pos.x = clamp(spot, d.bar.x0 + 0.25, d.bar.x1 - 0.25);
            c.bodyRoll = 0.2;
          } else if (w.rng() < dt * 0.35) {
            // Tolerated, or welcome. Either way it counts in the morning.
            w.rel.kindness(c.index, mate.index, 'roostedTogether');
          }
        }

        if (w.rng() < dt * (w.phase === 'night' ? 0.004 : 0.025)) {
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
    enter(c, w) {
      // Chickens dust bathe communally — a hen who sees a wallow in progress
      // gets into it, preferring one her friends are already in. This is
      // where the daytime friendships come from, and until it existed bonds
      // only ever formed at night on the roost, where nobody is squaring up
      // to anybody, so an alliance never had a fight to matter in.
      const wallow = others(c, w).filter((o) => o.bhv.name === 'dustBath' && o.bhv.data.bathing);
      const join = wallow.length
        ? (w.rel.best(c.index, wallow) ?? pick(w.rng, wallow))
        : null;
      if (join) {
        const a = rand(w.rng, 0, TAU);
        c.walkTo(hold(c, new THREE.Vector3(
          join.pos.x + Math.sin(a) * 0.5, 0, join.pos.z + Math.cos(a) * 0.5)), 1.2);
      } else {
        c.walkTo(randomPoint(w, c, 1.2), 0.8);
      }
      c.bhv.data.bathing = false;
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.bathing) {
        if (c.arrived(0.3)) { d.bathing = true; c.stop(); c.sitT = 1; }
        return;
      }
      c.bodyRoll = Math.sin(w.time * 5.2) * 0.35;
      c.flapT = 0.3 + Math.sin(w.time * 8) * 0.2;
      if (w.rng() < dt * 2.2) w.fx.puff(c.pos, 0x9a7f5c);
      // Wallowing in the same hole is how hens make friends.
      if (w.rng() < dt * 1.5) {
        for (const o of others(c, w)) {
          if (o.bhv.name === 'dustBath' && o.pos.distanceTo(c.pos) < 1.5) {
            w.rel.kindness(c.index, o.index, 'bathedTogether');
          }
        }
      }
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

  // Three boxes, seven hens, and one box everybody wants. Which box is
  // arbitrary and never explained, and a hen will queue for it, stare at the
  // occupant, and finally climb in on top of her rather than use one of the
  // two identical empty ones either side. This is not a caricature; it is
  // what chickens do.
  layEgg: {
    hen: true,
    zone: 'coop', weight: 0.55, dur: [16, 22], cooldown: 55, icon: 'egg',
    enter(c, w) {
      const d = c.bhv.data;
      d.phase = 'go';
      // Now and then she cannot be bothered and lays where she stands.
      if (w.rng() < 0.2) { d.nestIndex = -1; d.nest = null; c.stop(); return; }
      d.nestIndex = w.favouriteNest;
      d.nest = w.coop.nests[d.nestIndex];
      c.walkTo(d.nest, 0.9);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'go') {
        if (!d.nest || c.arrived(0.25)) {
          const sitter = nestOccupant(w, d.nestIndex, c);
          if (!sitter) settleOnNest(c, d);
          else if (c.rank < sitter.rank && !sitter.bhv.def?.committed) {
            // Seniority. Out you get.
            d.phase = 'evict';
            d.victim = sitter;
          } else {
            d.phase = 'queue';
            d.queueT = 0;
            c.stop();
          }
        }
      } else if (d.phase === 'evict') {
        const v = d.victim;
        c.facePoint(v ? v.pos : c.pos, dt, 5);
        if (c.doPeck()) {
          w.audio.squawk(1.15);
          if (v) {
            w.fx.feather(v.pos, v.color);
            w.rel.slight(c.index, v.index, 'evictedFromNest');
            w.director?.beat('evictedFromNest', v, c);
            v.force('flee', { from: c });
          }
          settleOnNest(c, d);
        }
      } else if (d.phase === 'queue') {
        // Waiting her turn, in the loosest sense. She stands at the lip and
        // cranes in, and her patience runs out well before the sitter's does.
        d.queueT += dt;
        c.facePoint(d.nest, dt, 3);
        c.neckPitchT = 0.45 + Math.sin(w.time * 2.2) * 0.2;
        if (w.rng() < dt * 0.5) c.showEmote(w.rng() < 0.5 ? 'question' : 'anger', 1.8);
        if (!nestOccupant(w, d.nestIndex, c)) { c.neckPitchT = 0; settleOnNest(c, d); }
        else if (d.queueT > 7) {
          // Fine. She will use it at the same time as her.
          d.phase = 'cram';
          c.neckPitchT = 0;
          c.walkTo(d.nest, 0.7);
          w.audio.squawk(0.85);
        }
      } else if (d.phase === 'cram') {
        // Two hens, one box, no dignity, and neither will give it up.
        const sitter = nestOccupant(w, d.nestIndex, c);
        c.bodyRoll = Math.sin(w.time * 11) * 0.2;
        if (sitter) {
          sitter.bodyRoll = Math.sin(w.time * 11 + 2) * 0.2;
          if (w.rng() < dt * 2.5) w.fx.feather(c.pos, sitter.color);
          if (w.rng() < dt * 0.8) sitter.showEmote('anger', 1.6);
        }
        if (c.arrived(0.3)) { c.bodyRoll = 0; settleOnNest(c, d); }
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
        if (!c.move || c.arrived()) c.walkTo(randomPoint(w, c), 1.1); // victory strut
        c.gait += dt * 4; // extra strut in the step
      }
    },
    exit(c) {
      c.sitT = 0; c.bodyRoll = 0; c.flapT = 0; c.neckPitchT = 0;
      c.bhv.data.onNest = false;
    },
  },

  // The full ceremony, no egg. Comedy is timing.
  phantomEgg: {
    hen: true,
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
        c.startHop(hold(c, fwd), 0.1, 0.3);
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
      c.walkTo(randomPoint(w, c), 3.0);
      c.bhv.data.infect = 0;
    },
    update(c, w, dt) {
      if (c.arrived(0.6)) c.walkTo(randomPoint(w, c), 3.0);
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
      c.walkTo(randomPoint(w, c), 0.95);
    },
    update(c, w, dt) {
      if (c.arrived(0.4)) c.walkTo(randomPoint(w, c), 0.95);
      if (w.rng() < dt * 0.25) c.showEmote('note', 2);
    },
    exit(c) { c.stop(); },
  },

  congaFollow: {
    weight: 0, dur: [10, 16], icon: 'note',
    enter(c, w) {
      // Falling in behind someone is the most ordinary way a friendship
      // starts, and until this was wired up none ever did.
      const l = c.bhv.data.leader;
      if (l) w.rel.kindness(l.index, c.index, 'followed');
    },
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
      // If there is someone in range she already has a problem with, it is
      // them. Otherwise whoever happens to be closest.
      const inRange = others(c, w).filter((o) => o.pos.distanceTo(c.pos) < 3.6);
      const rival = w.rel.worst(c.index, inRange) ?? nearest(c, w, 3.0);
      if (!rival) { c.bhv.t = c.bhv.dur; return; }
      c.bhv.data.rival = rival;
      rival.force('standoffB', { rival: c });
      c.stop();
      // She looks round for someone to back her up. This recruits rather than
      // waiting for a friend to happen to re-pick inside the six seconds a
      // standoff lasts — the same reason the rooster reacts to fights from
      // the tick instead of waiting his turn.
      const allies = others(c, w).filter(
        (o) => o !== rival && !o.bhv.def?.committed && o.pos.distanceTo(c.pos) < 7.5);
      // Not every time: backing decides the outcome almost outright, so if
      // a friend always turned up rank would stop meaning anything.
      const ally = w.rel.best(c.index, allies);
      if (ally && w.rng() < 0.45) ally.force('takeSides', { friend: c });
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
      if (!r) return;
      // The lower bird backs down — unless it doesn't, which is how a pecking
      // order actually changes. An upset swaps the two ranks for good.
      // Backing counts for more than rank does. Two against one is two
      // against one.
      const backing = (c.bhv.data.backup ? 1 : 0) - (r.bhv.data.backup ? 1 : 0);
      const upset = w.rng() < (backing < 0 ? 0.62 : backing > 0 ? 0.04 : 0.18);
      const cWins = (c.rank < r.rank) !== upset;
      const winner = cWins ? c : r;
      const loser = cWins ? r : c;
      if (upset) {
        const tmp = winner.rank; winner.rank = loser.rank; loser.rank = tmp;
        winner.showEmote('crown', 2.6);
      }
      w.rel.slight(winner.index, loser.index, upset ? 'deposed' : 'lostStandoff');
      if (upset) w.director?.beat('deposed', winner, loser);
      loser.force('flee', { from: winner });
    },
  },

  // She brought a friend. A bonded bird turns up at her shoulder and glares,
  // and the pair of them are much harder to face down — the standoff swings
  // to whoever has backing.
  takeSides: {
    weight: 2.2, weird: true, dur: [6, 9], cooldown: 34, icon: 'anger',
    can: (c, w) => !!sidingWith(c, w),
    enter(c, w) {
      // Recruited by the standoff itself, or found on her own initiative.
      const friend = c.bhv.data.friend ?? sidingWith(c, w);
      if (!friend || !friend.active || friend.bhv.data.backup) {
        c.bhv.t = c.bhv.dur;
        return;
      }
      c.bhv.data.friend = friend;
      friend.bhv.data.backup = c;
      w.audio.squawk(0.95);
      w.director?.beat('broughtBackup', c, friend.bhv.data.rival, friend);
    },
    update(c, w, dt) {
      const f = c.bhv.data.friend;
      if (!f || (f.bhv.name !== 'standoff' && f.bhv.name !== 'standoffB')) {
        c.bhv.t = c.bhv.dur;
        return;
      }
      // Shoulder to shoulder, both facing the same way.
      const at = f.pos.clone().add(
        new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw)).multiplyScalar(0.5));
      c.walkTo(hold(c, at), 1.5);
      if (c.arrived(0.3)) {
        c.stop();
        const r = f.bhv.data.rival;
        if (r) c.facePoint(r.pos, dt, 4);
        c.neckPitchT = Math.sin(w.time * 3.5 + 0.8) * 0.3;
      }
    },
    exit(c) {
      c.neckPitchT = 0;
      c.stop();
      const f = c.bhv.data.friend;
      if (f?.bhv.data.backup === c) f.bhv.data.backup = null;
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
      const spot = randomPoint(w, c, 1.0);
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
      if (m) w.rel.kindness(m.index, c.index, 'followed');
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
          c.startHop(hold(c, to), 0.55, 0.75); // the full extent of chicken aviation
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

// A hen goes broody: takes a nest, sits on it for a good long while,
  // growls at anyone who comes near, and eventually there are chicks.
  broody: {
    hen: true,
    // tough: a hen on her way to a nest was being bowled over by the flock
    // and, with a cooldown this long, never got another go at it.
    zone: 'coop', weight: 0.75, weird: true, tough: true, committed: true,
    dur: [46, 62], cooldown: 260, icon: 'egg',
    can: (c, w) => w.chicks.length > 0 && w.chicks.every((k) => !k.active)
      && w.phase !== 'night',
    enter(c, w) {
      // She wants the good box too, and being committed she gets to keep it.
      const d = c.bhv.data;
      d.nestIndex = nestOccupant(w, w.favouriteNest, c)
        ? Math.floor(w.rng() * w.coop.nests.length)
        : w.favouriteNest;
      d.nest = w.coop.nests[d.nestIndex];
      c.walkTo(d.nest, 1.05);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.sat) {
        if (c.arrived(0.3)) {
          d.sat = true; d.onNest = true;
          c.stop(); c.sitT = 1; c.lidT = 0.55;
        }
        return;
      }
      c.bodyRoll = Math.sin(w.time * 0.8) * 0.03;
      // Nobody comes near a broody hen twice.
      for (const o of others(c, w)) {
        if (o.pos.distanceTo(c.pos) < 0.95 && w.rng() < dt * 2) {
          c.showEmote('anger', 1.8);
          w.audio.squawk(0.8);
          o.force('flee', { from: c });
        }
      }
      if (w.rng() < dt * 0.1) c.showEmote('egg', 2);
    },
    exit(c, w) {
      c.sitT = 0; c.lidT = 0; c.bodyRoll = 0;
      c.bhv.data.onNest = false;
      if (c.bhv.data.sat) w.hatch(c, c.bhv.data.nest);
      // Interrupted before she settled: do not burn the long cooldown on an
      // attempt that never happened.
      else delete c.cooldowns.broody;
    },
  },

  // ---- the door, and the world beyond it ----------------------------------

  goOutside: {
    weight: 2.7, zone: 'coop', dur: [9, 13], cooldown: 10, icon: 'sun',
    can: (c, w) => w.door.open,
    enter(c, w) {
      c.bhv.data.phase = 'approach';
      c.walkTo(new THREE.Vector3(DOOR.inside.x, 0, DOOR.inside.z), rand(w.rng, 0.9, 1.15));
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!w.door.open) {
        // Shut in her face. Have a look at it, then give up.
        if (!d.rebuffed) { d.rebuffed = true; c.showEmote('question', 2.4); c.stop(); }
        return;
      }
      if (d.phase === 'approach') {
        if (c.arrived(0.32)) {
          d.phase = 'through';
          c.walkTo(new THREE.Vector3(DOOR.outside.x, 0, DOOR.outside.z), 1.1);
        }
      } else if (c.zone === 'yard' && c.arrived(0.45)) {
        c.bhv.t = c.bhv.dur;   // out. get on with something else
      }
    },
    exit(c) { c.stop(); },
  },

  goInside: {
    weight: 0.8, zone: 'yard', dur: [9, 13], cooldown: 20,
    // Only picked when there is a way in — but the rain forces it regardless,
    // and a flock shut out in a downpour is the whole joke.
    can: (c, w) => w.door.open,
    // Shut out in the wet, she does not give up and go and stand in a puddle;
    // she waits at the door. Breaks the moment it opens or the rain stops.
    next: (c, w) => (c.zone === 'yard' && !w.door.open && w.weather.rain > 0.35
      ? 'goInside' : null),
    enter(c, w) {
      c.bhv.data.phase = 'approach';
      c.walkTo(new THREE.Vector3(DOOR.outside.x, 0, DOOR.outside.z), rand(w.rng, 0.9, 1.15));
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!w.door.open) {
        // Shut out. Crowd up against the door and make it known. One target,
        // latched, so nobody oscillates on the spot.
        if (!d.rebuffed) {
          d.rebuffed = true;
          c.showEmote('question', 2.4);
          c.walkTo(hold(c, new THREE.Vector3(
            DOOR.outside.x + rand(w.rng, -0.8, 0.8), 0,
            DOOR.outside.z + rand(w.rng, 0, 0.7))), 1.0);
        } else if (c.arrived(0.3)) {
          c.stop();
          c.facePoint(DOOR.outside, dt, 2);
        }
        return;
      }
      if (d.phase === 'approach') {
        if (c.arrived(0.32)) {
          d.phase = 'through';
          c.walkTo(new THREE.Vector3(DOOR.inside.x, 0, DOOR.inside.z), 1.1);
        }
      } else if (c.zone === 'coop' && c.arrived(0.45)) {
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.stop(); },
  },

  peckGrass: {
    weight: 2.6, zone: 'yard', dur: [5, 10], icon: 'grain',
    enter(c, w) { c.walkTo(randomPoint(w, c), rand(w.rng, 0.6, 0.85)); },
    update(c, w, dt) {
      if (!c.arrived(0.3)) return;
      c.stop();
      if (w.rng() < dt * 2.6) c.doPeck();
      if (w.rng() < dt * 0.35) c.walkTo(randomPoint(w, c), 0.7);
    },
  },

  // Flopped on one side with a wing thrown out, motionless in the sun. Real
  // chickens do this and it looks exactly like they have died.
  sunbathe: {
    weight: 1.1, zone: 'yard', weird: true, dur: [11, 18], cooldown: 40, icon: 'sun',
    enter(c, w) { c.walkTo(randomPoint(w, c, 1.2), 0.7); c.bhv.data.down = false; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.down) {
        if (c.arrived(0.35)) {
          d.down = true;
          c.stop(); c.sitT = 1; c.fallT = 0.8; c.lidT = 0.9; c.flapT = 0.45;
        }
        return;
      }
      c.bodyRoll = Math.sin(w.time * 0.6) * 0.05;
      if (w.rng() < dt * 0.12) c.showEmote('sun', 2.4);
    },
    exit(c) { c.sitT = 0; c.fallT = 0; c.lidT = 0; c.flapT = 0; c.bodyRoll = 0; },
  },

  stumpPerch: {
    weight: 0.9, zone: 'yard', dur: [11, 18], cooldown: 35, icon: 'crown',
    can: (c, w) => !w.chickens.some((o) => o !== c && o.perch?.stump),
    enter(c, w) {
      const s = w.coop.yard.stump;
      c.bhv.data.phase = 'approach';
      c.walkTo(new THREE.Vector3(s.x, 0, s.z + 1.05), 0.9);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      const s = w.coop.yard.stump;
      if (d.phase === 'approach') {
        if (c.arrived(0.35)) {
          d.phase = 'up';
          c.startHop(new THREE.Vector3(s.x, s.y, s.z), 0.5, 0.6);
          w.audio.cluck(1.15);
        }
      } else if (d.phase === 'up' && !c.hop) {
        d.phase = 'king';
        c.perch = { stump: true };
      } else if (d.phase === 'king') {
        if (w.rng() < dt * 0.5) c.yaw += rand(w.rng, -1.1, 1.1);
        if (w.rng() < dt * 0.12) c.showEmote('crown', 2);
      }
    },
    exit(c, w) {
      if (c.perch) {
        c.perch = null;
        const down = hold(c, new THREE.Vector3(c.pos.x, 0, c.pos.z + 1.0));
        c.startHop(down, 0.3, 0.5);
      }
    },
  },

  splash: {
    weight: 0.75, zone: 'yard', weird: true, dur: [7, 11], cooldown: 40, icon: 'drop',
    enter(c, w) {
      const p = w.coop.yard.puddle;
      c.walkTo(new THREE.Vector3(p.x + rand(w.rng, -0.5, 0.5), 0, p.z + rand(w.rng, -0.5, 0.5)), 0.9);
    },
    update(c, w, dt) {
      if (!c.arrived(0.4)) return;
      c.stop();
      c.flapT = 0.4 + Math.sin(w.time * 9) * 0.3;
      c.bodyRoll = Math.sin(w.time * 6.5) * 0.16;
      if (w.rng() < dt * 3.5) w.fx.puff(c.pos, 0x8fb6c4);
    },
    exit(c) { c.flapT = 0; c.bodyRoll = 0; },
  },

  // ---- the worm: whoever gets there first is briefly the most important
  // chicken alive, and everyone else would like a word ----------------------

  chaseWorm: {
    weight: 0, dur: [12, 18], icon: 'worm',
    enter(c, w) { c.comeDown(); c.frozen = false; c.flapT = 0.3; },
    update(c, w, dt) {
      const worm = w.worm;
      if (!worm || worm.taken || c.zone !== 'yard') { c.bhv.t = c.bhv.dur; return; }
      c.flapT = Math.max(0, c.flapT - dt);
      c.walkTo(worm.pos, 2.5);
      if (c.pos.distanceTo(worm.pos) < 0.38) {
        w.takeWorm(c);
        c.force('wormVictory');
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  wormVictory: {
    // tough: converging on the worm puts everyone shoulder to shoulder at
    // speed, and the collision pile-up would knock the winner flat before she
    // got a single stride of her victory lap.
    weight: 0, weird: true, chained: true, tough: true, dur: [8, 12], icon: 'crown',
    enter(c, w) {
      w.audio.fanfare();
      c.flapT = 0.9;
      c.showEmote('crown', 3);
      // Possession is the whole game. Everyone else now wants it.
      for (const o of others(c, w)) {
        if (w.rng() < 0.85) o.force('chase', { victim: c, noFlee: true });
      }
      c.walkTo(randomPoint(w, c), 2.5);
    },
    update(c, w, dt) {
      c.flapT = Math.max(0, c.flapT - dt * 0.7);
      if (c.arrived(0.5)) c.walkTo(randomPoint(w, c), 2.4);
      if (w.rng() < dt * 1.2) w.fx.feather(c.pos, c.color);
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  // ---- the hawk: a shadow crosses the yard and everyone loses composure ----

  hawkPanic: {
    // tough for the same reason: seven chickens funnelling into one pop-hole
    // otherwise collapse into a heap and never make it inside.
    weight: 0, weird: true, chained: true, tough: true, dur: [9, 13], icon: 'bang',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.flapT = 1;
      w.audio.squawk(rand(w.rng, 0.7, 1.5));
      w.incident();
      c.bhv.data.stage = 'bolt';
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (w.rng() < dt * 2) w.fx.feather(c.pos, c.color);

      if (c.zone === 'yard') {
        if (w.door.open) {
          // Make for the pop-hole, single file, badly. Latched: once she has
          // reached the outside staging point she commits to going through,
          // or she oscillates on the threshold forever.
          if (!d.through && c.pos.distanceTo(DOOR_OUT) < 0.8) d.through = true;
          c.walkTo(d.through ? DOOR_IN : DOOR_OUT, 3.1);
        } else if (c.arrived(0.5)) {
          // Shut out. Run in circles instead, which does not help.
          c.walkTo(randomPoint(w, c), 3.1);
        }
        return;
      }

      // Safely indoors: get away from the doorway and crouch.
      if (d.stage === 'bolt') {
        if (c.pos.z < 2.2) { d.stage = 'cower'; c.stop(); }
        else if (c.arrived(0.5)) c.walkTo(randomPoint(w, c), 3.0);
        else if (!c.move) c.walkTo(randomPoint(w, c), 3.0);
      } else {
        c.sitT = 0.75;
        c.flapT = Math.max(0, c.flapT - dt * 0.5);
        c.headYawT = Math.sin(w.time * 4) * 0.6;
      }
    },
    exit(c) { c.flapT = 0; c.sitT = 0; c.headYawT = 0; c.stop(); },
  },

  // Rank has privileges: a higher bird simply takes the spot a lower one is
  // eating from. This is where the pecking order shows up in one moment
  // rather than over a whole session.
  displace: {
    weight: 0.7, weird: true, dur: [6, 9], cooldown: 26, icon: 'anger',
    can: (c, w) => pickTargets(c, w).length > 0,
    enter(c, w) {
      const targets = pickTargets(c, w);
      // Rank says she may; a grudge says who.
      c.bhv.data.target = w.rel.worst(c.index, targets)
        ?? (targets.length ? pick(w.rng, targets) : null);
      c.strut = 1;
    },
    update(c, w, dt) {
      const t = c.bhv.data.target;
      if (!t || !t.active) { c.bhv.t = c.bhv.dur; return; }
      c.walkTo(t.pos, 1.9);
      if (c.pos.distanceTo(t.pos) < 0.6) {
        c.doPeck();
        c.showEmote('anger', 2);
        w.audio.squawk(1.1);
        w.fx.feather(t.pos, t.color);
        w.rel.slight(c.index, t.index, 'displaced');
        t.force('flee', { from: c });
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.strut = 0; c.stop(); },
  },

  // ---- the mouse ----------------------------------------------------------
  // Chickens are dinosaurs, and this is the one moment the game says so out
  // loud. A flock that was dozing thirty seconds ago goes after it flat out.

  mouseHunt: {
    // tough: eight birds converging on one small target is exactly the
    // pile-up that collision separation turns into a stationary scrum.
    weight: 0, weird: true, chained: true, tough: true, dur: [12, 18], icon: 'eye',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.showEmote('eye', 1.8);
      w.audio.cluck(1.4);
    },
    update(c, w, dt) {
      const m = w.mouse;
      if (!m || m.done || c.zone !== 'coop') { c.bhv.t = c.bhv.dur; return; }
      // Head down, neck out, absolutely locked on.
      c.neckPitchT = 0.5;
      c.gaitAmp = 1;
      c.walkTo(m.pos, 2.9);
      if (c.pos.distanceTo(m.pos) < 0.4 && c.doPeck()) w.catchMouse(c);
    },
    exit(c) { c.neckPitchT = 0; c.stop(); },
  },

  // She has it, she is not sharing it, and now she is the most wanted
  // chicken in the building.
  mouseVictory: {
    weight: 0, weird: true, chained: true, tough: true, dur: [9, 13], icon: 'crown',
    enter(c, w) {
      w.audio.fanfare();
      c.showCatch(true);
      c.flapT = 0.8;
      w.incident();
      for (const o of others(c, w)) {
        if (w.rng() < 0.92) o.force('chase', { victim: c, noFlee: true });
      }
      c.walkTo(randomPoint(w, c), 2.9);
    },
    update(c, w, dt) {
      c.flapT = Math.max(0, c.flapT - dt * 0.6);
      if (c.arrived(0.5)) c.walkTo(randomPoint(w, c), 2.8);
      if (w.rng() < dt * 1.4) w.fx.feather(c.pos, c.color);
    },
    // Whatever else happens, she does not keep it.
    exit(c) { c.showCatch(false); c.flapT = 0; c.stop(); },
  },

  // ---- the butterfly ------------------------------------------------------

  // A hen versus a butterfly is a fair fight only in her opinion.
  chaseButterfly: {
    zone: 'yard', weight: 1.1, weird: true, dur: [9, 15], cooldown: 34, icon: 'star',
    can: (c, w) => !!w.butterfly?.active,
    update(c, w, dt) {
      const b = w.butterfly;
      if (!b?.active) { c.bhv.t = c.bhv.dur; return; }
      if (c.hop) return;               // mid-leap; let it play out
      const flat = new THREE.Vector3(b.pos.x, 0, b.pos.z);
      const gap = c.pos.distanceTo(flat);
      c.facePoint(flat, dt, 4);
      // Neck craned up at it the whole time, which is most of the joke.
      c.neckPitchT = -0.55;
      c.headTiltT = Math.sin(w.time * 3) * 0.2;
      if (gap > 0.75) { c.walkTo(flat, 1.9); return; }
      c.stop();
      // Close enough to try. Chicken aviation being what it is, she misses.
      if (w.rng() < dt * 1.6) {
        const to = c.pos.clone().lerp(flat, 1.35);
        c.startHop(hold(c, to), 0.75, 0.62);
        c.flapT = 1;
        w.audio.flutter();
        for (let i = 0; i < 2; i++) w.fx.feather(c.pos, c.color);
        b.startle(w);
      }
    },
    exit(c) { c.neckPitchT = 0; c.headTiltT = 0; c.flapT = 0; c.stop(); },
  },

  // ---- being picked up ----------------------------------------------------

  held: {
    weight: 0, weird: true, chained: true, tough: true, committed: true,
    dur: [200, 200], icon: 'bang',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.stop();
      c.flapT = 1;
      w.audio.squawk(1.3);
      w.incident();
    },
    update(c, w, dt) {
      if (!c.heldBy) { c.bhv.t = c.bhv.dur; return; }
      // Wings out, legs going, entirely without dignity.
      c.flapT = 0.75 + Math.sin(w.time * 12) * 0.25;
      c.legKick = 1;
      c.bodyRoll = Math.sin(w.time * 5) * 0.12;
      if (w.rng() < dt * 0.9) w.audio.squawk(rand(w.rng, 0.9, 1.5));
      if (w.rng() < dt * 1.4) w.fx.feather(c.pos, c.color);
    },
    exit(c) { c.flapT = 0; c.legKick = 0; c.bodyRoll = 0; },
  },

  // Put down, and with opinions about it.
  dropped: {
    weight: 0, weird: true, chained: true, dur: [4, 6], icon: 'anger',
    enter(c, w) {
      c.flapT = 1;
      w.audio.squawk(0.9);
    },
    update(c, w, dt) {
      if (c.falling) { c.flapT = 1; c.legKick = 1; return; }
      c.legKick = 0;
      c.flapT = Math.max(0, c.flapT - dt * 0.8);
      c.headYawT = Math.sin(w.time * 5) * 0.7;      // glaring around
      if (!c.move && c.bhv.t > 1.2) c.walkTo(randomPoint(w, c), 1.6);
    },
    exit(c) { c.flapT = 0; c.legKick = 0; c.headYawT = 0; c.stop(); },
  },

  // Out of the rain at last, and a foot of water comes off her. Fires when
  // the shower ends or when she gets under cover, whichever happens first.
  shakeOff: {
    weight: 0, weird: true, chained: true, dur: [2.2, 3.2], icon: 'drop',
    enter(c, w) { c.stop(); w.audio.cluck(1.1); },
    update(c, w, dt) {
      c.bodyRoll = Math.sin(w.time * 22) * 0.28;
      c.flapT = 0.55 + Math.sin(w.time * 18) * 0.35;
      if (w.rng() < dt * 6) w.fx.puff(c.pos, 0xa8c4d0);
      if (w.rng() < dt * 2) w.fx.feather(c.pos, c.color);
    },
    exit(c) { c.bodyRoll = 0; c.flapT = 0; },
  },

  // ---- the rooster --------------------------------------------------------
  // He is bigger, louder, and under the impression that the coop would not
  // function without him.

  crow: {
    rooster: true, weight: 1.5, weird: true, dur: [5, 7], cooldown: 22, icon: 'note',
    enter(c, w) {
      c.stop();
      c.bhv.data.at = rand(w.rng, 0.7, 1.5);
      c.bhv.data.done = false;
      c.strut = 1;
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.done) {
        // Winds up: chest out, neck rearing further and further back.
        c.neckPitchT = -0.3 - Math.min(0.7, c.bhv.t * 0.6);
        if (c.bhv.t > d.at) {
          d.done = true;
          c.neckPitchT = -1.15;
          c.flapT = 0.95;
          w.audio.crow();
          for (let i = 0; i < 3; i++) w.fx.feather(c.pos, c.color);
          // The whole coop stops for this, which is the point of it.
          for (const o of others(c, w)) {
            if (w.rng() < 0.75) o.force('lookAt', { at: c });
          }
        }
      } else {
        c.flapT = Math.max(0, c.flapT - dt * 1.1);
        if (c.bhv.t > d.at + 1.8) c.neckPitchT = 0;
      }
    },
    exit(c) { c.neckPitchT = 0; c.flapT = 0; c.strut = 0; },
  },

  // He finds something worth eating and calls everyone over to it. Real
  // roosters do this, and it is the only unselfish act in the coop.
  tidbit: {
    rooster: true, weight: 1.1, weird: true, dur: [9, 13], cooldown: 45, icon: 'grain',
    can: (c, w) => others(c, w).length >= 2,
    enter(c, w) {
      c.bhv.data.spot = randomPoint(w, c, 0.9);
      c.walkTo(c.bhv.data.spot, 1.1);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!c.arrived(0.3)) return;
      c.stop();
      c.facePoint(d.spot, dt);
      c.neckPitchT = 0.5;
      if (w.rng() < dt * 5) { c.doPeck(); w.audio.cluck(1.45); }
      if (!d.called) {
        d.called = true;
        // Tidbitting is courtship, and he has a favourite. She is called
        // first and every time; the rest are invited, and notice.
        const fav = w.chickens[w.favourite];
        if (fav?.active && fav.zone === c.zone && !fav.big) {
          fav.force('gawkJoin', { spot: d.spot });
          w.rel.kindness(c.index, fav.index, 'fedBy');
          fav.showEmote('heart', 2.4);
          c.showEmote('heart', 2.4);
        }
        for (const o of others(c, w)) {
          if (o === fav) continue;
          if (w.rng() < 0.8) { o.force('gawkJoin', { spot: d.spot }); w.rel.kindness(c.index, o.index, 'followed'); }
          // Watching him do that for her, again.
          if (fav && o !== fav) w.rel.adjust(o.index, w.favourite, -0.16);
        }
      }
    },
    exit(c) { c.neckPitchT = 0; },
  },

  // Two hens squaring up is his business, apparently.
  breakUpFight: {
    rooster: true, weight: 4.0, weird: true, dur: [5, 8], icon: 'anger',
    can: (c, w) => w.chickens.some((o) => o.active && o.bhv.name === 'standoff' && o.zone === c.zone),
    enter(c, w) {
      c.bhv.data.pair = w.chickens.find(
        (o) => o.active && o.bhv.name === 'standoff' && o.zone === c.zone) ?? null;
      c.flapT = 0.55;
      c.strut = 1;
    },
    update(c, w, dt) {
      const p = c.bhv.data.pair;
      if (!p) { c.bhv.t = c.bhv.dur; return; }
      c.walkTo(p.pos, 2.3);
      if (c.pos.distanceTo(p.pos) < 0.85) {
        // Grab the rival first: the moment p changes behavior its data goes.
        const rival = p.bhv.data.rival ?? null;
        c.showEmote('anger', 2.2);
        w.audio.squawk(0.7);
        p.force('flee', { from: c });
        if (rival) rival.force('flee', { from: c });
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.flapT = 0; c.strut = 0; c.stop(); },
  },

  // The perimeter will not walk itself.
  patrol: {
    rooster: true, weight: 1.4, dur: [12, 18], cooldown: 25, icon: 'crown',
    enter(c, w) {
      const b = bounds(c.zone);
      const m = 0.9;
      c.bhv.data.route = [
        new THREE.Vector3(b.x0 + m, 0, b.z0 + m), new THREE.Vector3(b.x1 - m, 0, b.z0 + m),
        new THREE.Vector3(b.x1 - m, 0, b.z1 - m), new THREE.Vector3(b.x0 + m, 0, b.z1 - m),
      ];
      let best = 0, bestD = 1e9;
      c.bhv.data.route.forEach((v, i) => {
        const d = v.distanceToSquared(c.pos);
        if (d < bestD) { bestD = d; best = i; }
      });
      c.bhv.data.i = best;
      c.strut = 1;
      c.walkTo(c.bhv.data.route[best], 0.85);
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (c.arrived(0.4)) {
        d.i = (d.i + 1) % d.route.length;
        c.walkTo(d.route[d.i], 0.85);
      }
      if (w.rng() < dt * 0.12) c.showEmote('crown', 1.8);
    },
    exit(c) { c.strut = 0; c.stop(); },
  },

  // He does not run from a fox. It rarely goes well, but he does not run.
  guardFox: {
    weight: 0, weird: true, chained: true, tough: true, committed: true,
    dur: [7, 10], icon: 'anger',
    enter(c, w) {
      c.flapT = 1;
      c.strut = 1;
      w.audio.squawk(0.5);
      w.incident();
      c.showEmote('anger', 2.6);
    },
    update(c, w, dt) {
      const fox = w.fox;
      if (!fox || fox.done) { c.bhv.t = c.bhv.dur; return; }
      c.walkTo(fox.pos, 3.2);
      if (w.rng() < dt * 1.5) w.fx.feather(c.pos, c.color);
      if (c.pos.distanceTo(fox.pos) < 1.1) {
        fox.scared = 4;
        for (let i = 0; i < 6; i++) w.fx.feather(c.pos, c.color);
        w.audio.crow();
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.flapT = 0; c.strut = 0; c.stop(); },
  },

// ---- the fox ------------------------------------------------------------

  foxFlee: {
    weight: 0, weird: true, chained: true, tough: true, dur: [6, 10], icon: 'bang',
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.flapT = 1;
      w.audio.squawk(rand(w.rng, 0.7, 1.4));
      w.incident();
    },
    update(c, w, dt) {
      const fox = c.bhv.data.from ?? w.fox;
      if (w.rng() < dt * 2.2) w.fx.feather(c.pos, c.color);
      if (!fox) {
        if (c.arrived(0.5)) c.walkTo(randomPoint(w, c), 3.0);
        return;
      }
      const away = c.pos.clone().sub(fox.pos);
      away.y = 0;
      if (away.lengthSq() < 0.01) away.set(1, 0, 0);
      away.normalize().multiplyScalar(3.2).add(c.pos);
      c.walkTo(hold(c, away), 3.2);
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  // A hen with chicks does not run from a fox. She runs at it, and it works.
  defendChicks: {
    weight: 0, weird: true, chained: true, tough: true, committed: true,
    dur: [6, 9], icon: 'anger',
    enter(c, w) {
      c.flapT = 1;
      w.audio.squawk(0.55);
      w.incident();
      c.showEmote('anger', 2.6);
    },
    update(c, w, dt) {
      const fox = w.fox;
      if (!fox || fox.done) { c.bhv.t = c.bhv.dur; return; }
      c.walkTo(fox.pos, 3.1);
      if (c.pos.distanceTo(fox.pos) < 1.0) {
        // Sees it off. A fox will not argue with this.
        fox.scared = 4;
        for (let i = 0; i < 5; i++) w.fx.feather(c.pos, c.color);
        w.audio.squawk(0.5);
        c.showEmote('anger', 2.4);
        c.bhv.t = c.bhv.dur;
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  // ---- behaviors that revolve around the matriarch ------------------------

  worship: {
    zone: 'coop', weight: 0.5, weird: true, dur: [8, 13], cooldown: 40, icon: 'heart',
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
    zone: 'coop', weight: 0.7, weird: true, dur: [12, 22], cooldown: 50, icon: 'crown',
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
      c.walkTo(randomPoint(w, c, 1.3), 0.42);
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
        if (--c.bhv.data.legs > 0) c.walkTo(randomPoint(w, c, 1.3), 0.42);
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

// ---- chicks ----------------------------------------------------------------
// A brood is mostly one behavior — stay with mum — plus small bursts of the
// things that make chicks funny: darting off, pecking at nothing, and piling
// up underneath her.

// How far a chick has strayed from her mother. A chick this far back stops
// having ideas of her own until she has caught up.
function mumGap(c) {
  if (!c.mum || c.mum.zone !== c.zone) return 99;
  return c.pos.distanceTo(c.mum.pos);
}

export const CHICK_BEHAVIORS = {
  followMum: {
    weight: 6, dur: [3, 6],
    update(c, w, dt) {
      const m = c.mum;
      if (!m) return;
      if (m.zone !== c.zone) {
        // Mum went through the pop-hole. Aim at the staging point on this
        // side, then at the one beyond it — walking between the two carries
        // her through the opening. Once across, zones match and this branch
        // stops firing, so there is nothing to oscillate.
        if (!w.door.open) {
          c.stop();
          if (w.rng() < dt * 0.6) c.showEmote('question', 1.6);
          return;
        }
        const stage = c.zone === 'coop' ? DOOR_IN : DOOR_OUT;
        const beyond = c.zone === 'coop' ? DOOR_OUT : DOOR_IN;
        // Latched on the chick, not on the behavior: followMum re-picks every
        // few seconds, and without a latch that outlives it she hunts between
        // the two staging points and never actually goes through.
        if (!c.crossing && c.pos.distanceTo(stage) < 0.55) c.crossing = true;
        c.walkTo(c.crossing ? beyond : stage, 2.0);
        return;
      }
      c.crossing = false;   // same side as mum again
      // Line up behind her, one slot back each.
      const spot = new THREE.Vector3(-Math.sin(m.yaw), 0, -Math.cos(m.yaw))
        .multiplyScalar(0.3 + c.slot * 0.15).add(m.pos);
      spot.y = 0;
      const gap = c.pos.distanceTo(spot);
      if (gap > 0.16) c.walkTo(hold(c, spot, 0.15), gap > 1.6 ? 3.1 : 1.3);
      else { c.stop(); if (w.rng() < dt * 1.2) c.doPeck(); }
      // Left behind: peep about it.
      if (gap > 2.6 && w.rng() < dt * 0.5) c.showEmote('question', 1.6);
    },
    exit(c) { c.stop(); },
  },

  chickPeck: {
    weight: 1.8, dur: [1.4, 2.8],
    can: (c) => mumGap(c) < 2.2,
    enter(c) { c.stop(); },
    update(c, w, dt) {
      if (w.rng() < dt * 4) c.doPeck();
      if (w.rng() < dt * 1.2) c.yaw += rand(w.rng, -1.2, 1.2);
    },
  },

  // A chick at full tilt, for no reason, in a straight line.
  chickDart: {
    weight: 1.3, weird: true, dur: [1.2, 2.2], icon: 'star',
    can: (c) => mumGap(c) < 2,
    enter(c, w) { c.walkTo(randomPoint(w, c, 0.6), 2.8); c.flapT = 0.7; },
    update(c, w, dt) { if (c.arrived(0.3)) c.walkTo(randomPoint(w, c, 0.6), 2.8); },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  // Wedged under mum, which is where a chick most wants to be.
  chickHuddle: {
    weight: 1.5, dur: [5, 10],
    can: (c, w) => !!c.mum && c.mum.zone === c.zone && mumGap(c) < 3,
    enter(c, w) {
      // A snapshot can force this on a chick with no mother, so enter() must
      // not assume the `can` gate ran.
      const m = c.mum;
      if (!m) { c.stop(); return; }
      c.walkTo(new THREE.Vector3(
        m.pos.x + rand(w.rng, -0.24, 0.24), 0, m.pos.z + rand(w.rng, -0.28, 0.05)), 1.6);
    },
    update(c, w, dt) {
      if (!c.arrived(0.22)) return;
      c.stop();
      c.sitT = 1;
      c.lidT = 0.85;
      if (w.rng() < dt * 0.25) w.fx.zzz(c.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), 0.1);
    },
    exit(c) { c.sitT = 0; c.lidT = 0; },
  },

  // A soggy chick is twice the shake for half the chicken.
  shakeOff: {
    weight: 0, weird: true, chained: true, dur: [1.6, 2.4], icon: 'drop',
    enter(c, w) { c.stop(); w.audio.cluck(1.7); },
    update(c, w, dt) {
      c.bodyRoll = Math.sin(w.time * 30) * 0.34;
      c.flapT = 0.6 + Math.sin(w.time * 24) * 0.4;
      if (w.rng() < dt * 5) w.fx.puff(c.pos, 0xa8c4d0);
    },
    exit(c) { c.bodyRoll = 0; c.flapT = 0; },
  },
};

// Behaviors that only make sense with a partner or a target that a snapshot
// does not carry — a follower needs its leader, a rush needs its seed patch.
// A client restoring from a snapshot puts these chickens back on `wander`
// instead and lets them pick again; positions stay correct either way, which
// is what the snapshot is really for.
// mouseVictory is here because the mouse itself cannot be restored: resuming
// it would put a mouse in the beak of a hen who never caught one.
const NEEDS_CONTEXT = new Set(['congaFollow', 'standoffB', 'gawkJoin', 'seedRush', 'lookAt',
  'chickHuddle', 'mouseVictory']);
export const isResumable = (name) => !NEEDS_CONTEXT.has(name);

// Chickens keep farm hours. Rather than special-casing every behavior, the
// time of day just reweights the whole table: at dusk going in and roosting
// dominate, at night almost nothing else is even considered, and at first
// light they pour back outside. A name absent from a phase uses that phase's
// `_` default.
const PHASE_BIAS = {
  day: null,                                  // no bias at all
  dusk: {
    _: 0.7,
    goOutside: 0, sunbathe: 0, splash: 0, stumpPerch: 0.2,
    goInside: 14, roost: 7, eat: 2, drink: 1.6, sleep: 1.5,
  },
  night: {
    _: 0.03,                                  // the coop is asleep
    roost: 40, sleep: 30, goInside: 8, goOutside: 0,
    sunbathe: 0, splash: 0, peckGrass: 0.2, stumpPerch: 0,
  },
  dawn: {
    _: 0.8,
    goOutside: 6, roost: 0.05, sleep: 0.1, peckGrass: 2, eat: 2,
  },
};

const BIG_PHASE_BIAS = {
  day: null,
  dusk: { _: 0.5, bigSleep: 4, bigSettle: 2 },
  night: { _: 0.02, bigSleep: 50, bigStir: 1 },
  dawn: { _: 0.7, bigStir: 2, bigEat: 2 },
};

// Wet weather on top of the time of day. Multiplies with the phase bias, so
// a rainy dusk drives everyone indoors twice as hard.
const RAIN_BIAS = {
  _: 0.85,
  goOutside: 0.03, sunbathe: 0, dustBath: 0.05, stumpPerch: 0.1,
  peckGrass: 0.35, goInside: 10, splash: 3.5, eat: 1.6, roost: 1.5,
};

function rainWeight(name, w, c) {
  if (c.chick || !w.weather || w.weather.rain < 0.35) return 1;
  return RAIN_BIAS[name] ?? RAIN_BIAS._;
}

function phaseWeight(name, w, c) {
  if (c.chick) return 1;   // chicks go where mum goes
  const table = (c.big ? BIG_PHASE_BIAS : PHASE_BIAS)[w.phase];
  if (!table) return 1;
  return table[name] ?? table._;
}

// ---- state machine plumbing ------------------------------------------------

const TABLES = { normal: BEHAVIORS, big: BIG_BEHAVIORS, chick: CHICK_BEHAVIORS };
const PICKABLE = {
  normal: Object.entries(BEHAVIORS).filter(([, d]) => d.weight > 0),
  big: Object.entries(BIG_BEHAVIORS).filter(([, d]) => d.weight > 0),
  chick: Object.entries(CHICK_BEHAVIORS).filter(([, d]) => d.weight > 0),
};

// Bertha cannot be startled, seeded, or chased like an ordinary chicken;
// requests aimed at her get translated or dropped.
const BIG_ALIASES = {
  seedRush: 'bigSeedRush', wander: 'bigSettle',
  panic: null, flee: null, lookAt: null, bonk: null, gawkJoin: null,
};

// Guards against a behavior's exit() handler triggering another transition,
// which would re-enter that same exit(). Chain with `next` instead.
//
// An exit that forces a behavior on the chicken it belongs to cannot install
// it here either: the transition that triggered the exit is still in flight
// and is about to overwrite c.bhv. forceBehavior parks the request in
// c._pending and whoever is doing that transition picks it up.
function runExit(c, w) {
  if (c._inExit) return;
  c._inExit = true;
  try { c.bhv.def?.exit?.(c, w); } finally { c._inExit = false; }
}

// Install a request parked by an exit handler, if there is one. Returns the
// new behavior, or null if the caller should carry on with its own.
function takePending(c, w) {
  const p = c._pending;
  if (!p) return null;
  c._pending = null;
  c.frozen = false;
  return enterBehavior(c, w, p.name, p.def, p.data, true);
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
    if (def.zone && def.zone !== c.zone) continue;
    if (def.rooster && !c.rooster) continue;
    if (def.hen && c.rooster) continue;
    if (def.can && !def.can(c, w)) continue;
    if ((c.cooldowns[name] ?? 0) > w.time) continue;
    let weight = def.weight * (def.weird ? c.weirdMul : 1) * phaseWeight(name, w, c) * rainWeight(name, w, c);
    if (weight <= 0) continue;
    if (name === c.bhv.lastName) weight *= 0.25; // variety, but repeats stay possible
    total += weight;
    bag.push([name, def, weight]);
  }
  let roll = w.rng() * total;
  for (const [name, def, weight] of bag) {
    roll -= weight;
    if (roll <= 0) return enterBehavior(c, w, name, def, {});
  }
  const fallback = c.big ? 'bigSleep' : (c.chick ? 'followMum' : 'wander');
  return enterBehavior(c, w, fallback, table[fallback], {});
}

// A hawk is the one thing that outranks a committed behavior.
const OVERRIDES_COMMITMENT = new Set(['hawkPanic', 'held', 'dropped']);

export function forceBehavior(c, w, name, data = {}) {
  // A hen who has decided to sit on a nest is not to be talked out of it by
  // whoever fancies a chase.
  if (c.bhv.def?.committed && !OVERRIDES_COMMITMENT.has(name)) return c.bhv;
  // Sex-specific behaviors are an invariant, not a preference: forcing is
  // used from a dozen places and a hen must never end up crowing.
  const want = BEHAVIORS[name];
  if (want?.rooster && !c.rooster) return c.bhv;
  if (want?.hen && c.rooster) return c.bhv;
  if (c.big) {
    if (name in BIG_ALIASES) name = BIG_ALIASES[name];
    if (!name) return c.bhv;      // she is unbothered
  }
  // Bertha only ever runs her own table. Without this, any new behavior added
  // for the flock silently becomes hers too, at flock speeds.
  const def = (c.big || c.chick)
    ? (TABLES[c.table][name] ?? null)
    : ((TABLES[c.table] ?? BEHAVIORS)[name] ?? BEHAVIORS[name]);
  if (!def) return c.bhv;
  // Called from inside this chicken's own exit(): park it, because whatever
  // triggered the exit is about to assign c.bhv over the top.
  if (c._inExit) { c._pending = { name, def, data }; return c.bhv; }
  c.frozen = false;
  runExit(c, w);
  // An explicit force outranks anything the outgoing behavior asked for.
  c._pending = null;
  return enterBehavior(c, w, name, def, data, true);
}

function enterBehavior(c, w, name, def, data, forced = false) {
  const prev = c.bhv;
  if (!forced) {
    runExit(c, w);
    const pending = takePending(c, w);
    if (pending) return pending;
  }
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
