import * as THREE from 'three';
import { clamp, lerp, pick, rand, TAU, wrapAngle } from './util.js';

// Every strange thing a chicken can decide to do lives here. Each behavior:
//   weight   relative chance of being picked
//   weird    counts toward the "weird moments" tally and uses the chicken's
//            personal weirdness multiplier
//   dur      [min,max] seconds before the next decision
//   can      optional gate; enter/update/exit drive the chicken
//   lines    ticker one-liners ({n} = this chicken, {m} = other chicken)

const AREA = 4.1;
const V = () => new THREE.Vector3();

function randomPoint(w, margin = 0.4) {
  return new THREE.Vector3(
    rand(w.rng, -(AREA - margin), AREA - margin), 0,
    rand(w.rng, -(AREA - margin), AREA - margin));
}

function say(w, c, lines, other) {
  if (!lines) return;
  let line = typeof lines === 'string' ? lines : pick(w.rng, lines);
  line = line.replaceAll('{n}', c.name).replaceAll('{m}', other?.name ?? '???');
  w.ui.tick(line);
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
    weight: 1.2, dur: [5, 9],
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
    weight: 0.8, dur: [5, 8],
    lines: ['{n} is drinking like nobody taught her how.'],
    quiet: 0.85,
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
    weight: 0.9, weird: true, dur: [3, 6],
    lines: ['{n} has the zoomies.', '{n} is running laps. Training for something.',
      '{n} suddenly remembered she can run.'],
    enter(c, w) { c.flapT = 0.5; c.walkTo(randomPoint(w), 2.6); },
    update(c, w, dt) {
      if (c.arrived(0.5)) c.walkTo(randomPoint(w), 2.6);
      if (w.rng() < dt * 1.5) w.fx.feather(c.pos, c.color);
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  stareWall: {
    weight: 0.7, weird: true, dur: [6, 14],
    lines: ['{n} is having a staring contest with the wall.',
      '{n} found a very interesting wall.',
      '{n} is facing the wall. Thinking about what she did.'],
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
      if (c.arrived(0.3)) c.facePoint(c.bhv.data.wall, dt, 3);
    },
  },

  stareYou: {
    weight: 0.8, weird: true, dur: [5, 11],
    lines: ['{n} is watching you.', '{n} knows you are there.',
      '{n} is looking directly into your soul.'],
    enter(c, w) {
      c.stop();
      c.bhv.data.creep = w.rng() < 0.35; // sometimes she comes closer. slowly.
    },
    update(c, w, dt) {
      const cam = w.camera.position;
      c.facePoint(cam, dt, 4);
      c.headTiltT = Math.sin(w.time * 0.7) * 0.45;
      if (c.bhv.data.creep && w.camera.position.distanceTo(c.pos) > 1.4) {
        c.pos.x += Math.sin(c.yaw) * 0.14 * dt;
        c.pos.z += Math.cos(c.yaw) * 0.14 * dt;
        c.gaitAmp = 0.25; c.gait += dt * 2.5; // slow, deliberate steps
        if (!c.bhv.data.said && c.bhv.t > 2.5) {
          c.bhv.data.said = true;
          say(w, c, ['{n} is coming for you.']);
        }
      }
    },
    exit(c) { c.headTiltT = 0; },
  },

  statue: {
    weight: 0.6, weird: true, dur: [4, 9],
    lines: ['{n} is pretending to be a statue.',
      '{n} stopped. Completely. Mid-stride.',
      '{n} has become sculpture.'],
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
    weight: 0.5, weird: true, dur: [4.5, 6.5],
    lines: ['{n} is spinning. Nobody knows why.', '{n} initiated spin protocol.'],
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
        // Dizzy aftermath: a decaying wobble.
        if (!d.saidDizzy) { d.saidDizzy = true; say(w, c, ['{n} is dizzy now and regrets everything.']); }
        const left = 1 - (c.bhv.t - d.spinT) / (c.bhv.dur - d.spinT);
        c.bodyRoll = Math.sin(w.time * 9) * 0.25 * Math.max(0, left);
      }
    },
    exit(c) { c.bodyRoll = 0; },
  },

  moonwalk: {
    weight: 0.5, weird: true, dur: [3, 5],
    lines: ['{n} is moonwalking. Incredible.', '{n} discovered reverse gear.'],
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
    weight: 0.4, weird: true, dur: [3, 5.5],
    lines: ['{n} is sidling. Suspicious.', '{n} is moving sideways so you will not notice her.'],
    enter(c, w) { c.stop(); c.bhv.data.dir = w.rng() < 0.5 ? -1 : 1; },
    update(c, w, dt) {
      c.facePoint(w.camera.position, dt, 3);
      const strafeYaw = c.yaw + (Math.PI / 2) * c.bhv.data.dir;
      c.pos.x += Math.sin(strafeYaw) * 0.4 * dt;
      c.pos.z += Math.cos(strafeYaw) * 0.4 * dt;
      c.gaitAmp = 0.7; c.gait += dt * 8;
    },
  },

  jumpScare: {
    weight: 0.6, weird: true, dur: [2.5, 4],
    lines: ['{n} jumped. There was nothing there.',
      '{n} levitated briefly. No comment.'],
    enter(c, w) { c.stop(); c.bhv.data.at = rand(w.rng, 0.4, 1.6); c.bhv.data.done = false; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (!d.done && c.bhv.t >= d.at) {
        d.done = true;
        c.startHop(c.pos, rand(w.rng, 0.45, 0.7), 0.5);
        w.audio.squawk(1.3);
        w.fx.feather(c.pos, c.color);
      }
      if (d.done && !c.hop) c.headYawT = Math.sin(w.time * 6) * 0.7; // frantic look-around
    },
    exit(c) { c.headYawT = 0; },
  },

  investigate: {
    weight: 0.9, weird: true, quiet: 0.5, dur: [5, 9],
    lines: ['{n} found something. It is nothing.',
      '{n} is inspecting a very specific spot.',
      '{n} demands answers from the floor.'],
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
    weight: 0.7, weird: true, dur: [4, 7], cooldown: 12,
    // no `lines`: announced from enter(), once the victim is known
    can(c, w) { return w.chickens.some((o) => o !== c && !o.perch && o.bhv.name !== 'panic'); },
    enter(c, w) {
      const victims = w.chickens.filter((o) => o !== c && !o.perch && o.bhv.name !== 'panic');
      const v = pick(w.rng, victims);
      c.bhv.data.victim = v;
      v.force('flee', { from: c });
      c.flapT = 0.35;
      if (w.rng() < 0.8) {
        say(w, c, ['{n} is chasing {m} for personal reasons.',
          '{n} has declared war on {m}.',
          '{n} would like a word with {m}.'], v);
      }
    },
    update(c, w, dt) {
      const v = c.bhv.data.victim;
      c.walkTo(v.pos, 2.1);
      if (c.pos.distanceTo(v.pos) < 0.45) {
        say(w, c, ['{n} caught {m}. Nothing happened.', '{n} caught {m} and immediately lost interest.'], v);
        v.force('wander');
        c.bhv.t = c.bhv.dur; // done
      }
    },
    exit(c) { c.flapT = 0; c.stop(); },
  },

  flee: {
    weight: 0, dur: [3, 5],
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
    lines: ['{n} took the high ground.'],
    quiet: 0.7,
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
        if (w.rng() < dt * 0.02) {
          say(w, c, ['{n} fell off the roost.', '{n} forgot how perching works.']);
          c.comeDown();
          c.force('panic', { short: true });
        }
      }
    },
    exit(c, w) {
      c.bodyRoll = 0;
      if (c.perch) { c.comeDown(); }
    },
  },

  dustBath: {
    weight: 0.8, weird: true, dur: [7, 12], cooldown: 25,
    lines: ['{n} is taking a dust bath. Filthy and delighted.',
      '{n} is rolling in the dirt on purpose.'],
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

  sleep: {
    weight: 0.7, weird: true, dur: [9, 16], cooldown: 30,
    lines: ['{n} fell asleep standing up.', '{n} has powered down.'],
    enter(c, w) {
      c.stop();
      c.bhv.data.standing = w.rng() < 0.5;
      if (!c.bhv.data.standing) c.sitT = 1;
      c.neckPitchT = 0.5;
      c.headYawT = 1.9; // head tucked back toward the wing
      c.bhv.data.z = 0;
    },
    update(c, w, dt) {
      c.bhv.data.z -= dt;
      if (c.bhv.data.z <= 0) {
        c.bhv.data.z = 1.5;
        w.fx.zzz(c.pos.clone().add(new THREE.Vector3(0, 0.75, 0)));
      }
    },
    exit(c) { c.sitT = 0; c.neckPitchT = 0; c.headYawT = 0; },
  },

  layEgg: {
    weight: 0.55, dur: [9, 12], cooldown: 55,
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
          w.spawnEgg(eggPos, !!d.nest);
          w.audio.fanfare();
          c.flapT = 0.9;
          say(w, c, d.nest
            ? ['{n} laid an egg like a professional.', '{n} produced an egg. Flawless technique.']
            : ['{n} laid an egg right there on the floor. No notes.',
               '{n} laid an egg wherever she happened to be standing.']);
        }
      } else if (d.phase === 'proud') {
        c.flapT = Math.max(0, c.flapT - dt * 1.5);
        if (!c.move || c.arrived()) c.walkTo(randomPoint(w), 1.1); // victory strut
        c.gait += dt * 4; // extra strut in the step
      }
    },
    exit(c) { c.sitT = 0; c.bodyRoll = 0; c.flapT = 0; },
  },

  panic: {
    weight: 0.15, weird: true, dur: [2.5, 5], cooldown: 18,
    lines: ['{n} is panicking about absolutely nothing.',
      'PANIC! {n} saw something. There was nothing.',
      '{n} remembered a bad dream and is handling it poorly.'],
    enter(c, w) {
      c.comeDown();
      c.frozen = false;
      c.flapT = 1;
      if (c.bhv.data.short) c.bhv.dur = 1.8;
      w.audio.squawk(1);
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
        for (const o of w.chickens) {
          if (o === c || o.bhv.name === 'panic') continue;
          if (o.pos.distanceTo(c.pos) < 2.0 && w.rng() < 0.3) {
            o.force('panic');
            if (w.rng() < 0.5) say(w, o, ['{m} convinced {n} to also panic.'], c);
          }
        }
      }
    },
    exit(c, w) {
      c.flapT = 0; c.stop();
      if (w.rng() < 0.35) say(w, c, ['{n} has calmed down. Crisis averted (there was no crisis).']);
    },
  },

  seedRush: {
    weight: 0, dur: [8, 14],
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
          if (patch.count <= 0) say(w, c, ['The seeds are gone. {n} double-checked.']);
        }
      }
    },
    exit(c) { c.stop(); c.flapT = 0; },
  },
};

// ---- state machine plumbing ----------------------------------------------

const PICKABLE = Object.entries(BEHAVIORS).filter(([, d]) => d.weight > 0);

export function pickBehavior(c, w) {
  let total = 0;
  const bag = [];
  for (const [name, def] of PICKABLE) {
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
  return enterBehavior(c, w, 'wander', BEHAVIORS.wander, {});
}

export function forceBehavior(c, w, name, data = {}) {
  c.frozen = false;
  c.bhv.def?.exit?.(c, w);
  enterBehavior(c, w, name, BEHAVIORS[name], data, true);
}

function enterBehavior(c, w, name, def, data, forced = false) {
  const prev = c.bhv;
  if (!forced) prev.def?.exit?.(c, w);
  c.bhv = {
    name, def, t: 0, data,
    dur: rand(w.rng, def.dur[0], def.dur[1]),
    lastName: prev.name,
  };
  if (def.cooldown) c.cooldowns[name] = w.time + def.cooldown + rand(w.rng, 0, def.cooldown);
  if (def.weird && !forced) w.ui.addWeird();
  if (def.lines && !forced && w.rng() > (def.quiet ?? 0.25)) say(w, c, def.lines);
  else if (def.lines && forced && name === 'panic' && w.rng() < 0.5) say(w, c, def.lines);
  def.enter?.(c, w);
  return c.bhv;
}
