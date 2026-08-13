import * as THREE from 'three';
import { clamp, pick, rand, TAU } from './util.js';

// Every strange thing a chicken can decide to do lives here. Each behavior:
//   weight   relative chance of being picked (0 = only ever forced)
//   weird    counts toward the "weird moments" tally and uses the chicken's
//            personal weirdness multiplier
//   dur      [min,max] seconds before the next decision
//   cooldown seconds (plus up to as many again) before it can repeat
//   can      optional gate; enter/update/exit drive the chicken
//   next     chain to this behavior when the timer expires naturally;
//            may be a function (c, w) => name. Use this instead of calling
//            c.force() from exit(), which would re-enter the exit handler.
//   lines    ticker one-liners ({n} = this chicken, {m} = other chicken)

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

function nearest(c, w, maxDist = 99) {
  let best = null, bestD = maxDist;
  for (const o of others(c, w)) {
    const d = o.pos.distanceTo(c.pos);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function say(w, c, lines, other) {
  if (!lines) return;
  let line = typeof lines === 'string' ? lines : pick(w.rng, lines);
  line = line.replaceAll('{n}', c.name).replaceAll('{m}', other?.name ?? 'someone');
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
    can(c, w) { return others(c, w).some((o) => o.bhv.name !== 'panic'); },
    enter(c, w) {
      const victims = others(c, w).filter((o) => o.bhv.name !== 'panic');
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

  // The full ceremony, no egg. Comedy is timing.
  phantomEgg: {
    weight: 0.5, weird: true, dur: [8, 10], cooldown: 45,
    enter(c, w) { c.stop(); c.sitT = 1; c.bhv.data.phase = 'strain'; },
    update(c, w, dt) {
      const d = c.bhv.data;
      if (d.phase === 'strain') {
        c.bodyRoll = Math.sin(w.time * 20) * 0.06;
        c.flapT = Math.min(0.5, c.bhv.t * 0.2);
        if (c.bhv.t > 3.4) {
          d.phase = 'nothing';
          c.bodyRoll = 0; c.flapT = 0; c.sitT = 0;
          say(w, c, ['{n} tried to lay an egg. Nothing happened. {n} is processing this.',
            '{n} braced for an egg that never came.',
            '{n} made a considerable effort and produced nothing at all.']);
        }
      } else {
        // stares back at the spot where the egg should be
        c.neckPitchT = 0.6;
        c.headTiltT = Math.sin(w.time * 1.4) * 0.4;
      }
    },
    exit(c) { c.sitT = 0; c.bodyRoll = 0; c.flapT = 0; c.neckPitchT = 0; c.headTiltT = 0; },
  },

  panic: {
    weight: 0.15, weird: true, dur: [2.5, 5], cooldown: 18, quiet: 0.72,
    lines: ['{n} is panicking about absolutely nothing.',
      'PANIC! {n} saw something. There was nothing.',
      '{n} remembered a bad dream and is handling it poorly.'],
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

  // ---- social nonsense ----------------------------------------------------

  conga: {
    weight: 0.55, weird: true, dur: [10, 16], cooldown: 40,
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
      if (n >= 2) {
        say(w, c, [`A conga line has formed behind {n}. Nobody knows why.`,
          `{n} is leading a procession of ${n}. Destination unknown.`,
          `{n} has followers now.`]);
      }
    },
    update(c, w, dt) {
      if (c.arrived(0.4)) c.walkTo(randomPoint(w), 0.95);
    },
    exit(c, w) {
      c.stop();
      if (c.bhv.data.count >= 2 && w.rng() < 0.6) {
        say(w, c, ['The conga line has disbanded. No one will speak of it.']);
      }
    },
  },

  congaFollow: {
    weight: 0, dur: [10, 16],
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
    weight: 0.6, weird: true, dur: [6, 9], cooldown: 30,
    can(c, w) { return !!nearest(c, w, 3.0); },
    enter(c, w) {
      const rival = nearest(c, w, 3.0);
      if (!rival) { c.bhv.t = c.bhv.dur; return; }
      c.bhv.data.rival = rival;
      rival.force('standoffB', { rival: c });
      c.stop();
      say(w, c, ['{n} and {m} are having a disagreement.',
        '{n} has squared up to {m}.',
        '{n} and {m} are standing very close and saying nothing.'], rival);
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
      if (r && w.rng() < 0.7) {
        say(w, c, ['{m} backed down. {n} has won something.',
          'Nothing was resolved between {n} and {m}.'], r);
        r.force('flee', { from: c });
      }
    },
  },

  standoffB: {
    weight: 0, dur: [6, 9],
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
    weight: 0.55, weird: true, dur: [7, 10], cooldown: 28,
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
          w.audio.squawk(1.35);
          w.fx.feather(v.pos, v.color);
          w.incident();
          say(w, c, ['{n} pecked {m} and is now pretending she did not.',
            '{n} got {m} right on the tail.'], v);
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
    weight: 0.6, weird: true, dur: [8, 13], cooldown: 35,
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
      if (n >= 1) {
        say(w, c, ['{n} is staring at something on the floor. A crowd is forming.',
          'Everyone has come to look at whatever {n} found.']);
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
      if (w.rng() < 0.7) say(w, c, ['There was nothing there. Everyone leaves disappointed.']);
    },
  },

  gawkJoin: {
    weight: 0, dur: [6, 10],
    enter(c, w) {
      const s = c.bhv.data.spot;
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
    weight: 0.45, weird: true, dur: [1, 1.5], cooldown: 30,
    can(c, w) { return !!nearest(c, w, 3.5); },
    enter(c, w) {
      const m = nearest(c, w, 3.5);
      // Copy only solo behaviors; the multi-actor ones need their own casting.
      const SOLO = ['peckAround', 'stareWall', 'statue', 'spin', 'moonwalk', 'sidle',
        'zoomies', 'investigate', 'dustBath', 'oneLeg', 'existential', 'stareYou'];
      if (m && SOLO.includes(m.bhv.name)) {
        say(w, c, ['{n} is copying {m}.', '{n} saw {m} do it and thought it looked correct.'], m);
        c.bhv.data.copy = m.bhv.name;
      }
    },
    // Chain into the copied behavior once the beat lands.
    next: (c) => c.bhv.data.copy ?? 'peckAround',
  },

  existential: {
    weight: 0.5, weird: true, dur: [7, 12],
    lines: ['{n} is looking at the ceiling and questioning everything.',
      '{n} has begun to wonder what any of this is for.',
      '{n} is contemplating the nature of the coop.'],
    enter(c, w) { c.stop(); },
    update(c, w, dt) {
      c.neckPitchT = -0.95; // head all the way back, staring up
      c.headTiltT = Math.sin(w.time * 0.5) * 0.18;
    },
    exit(c) { c.neckPitchT = 0; c.headTiltT = 0; },
  },

  oneLeg: {
    weight: 0.5, weird: true, dur: [6, 11],
    lines: ['{n} is standing on one leg to prove a point.',
      '{n} has retracted a leg. The other one is fine.',
      '{n} is down to one leg and seems pleased about it.'],
    enter(c, w) { c.stop(); c.legTuckT = 1; },
    update(c, w, dt) {
      // the wobble of someone regretting a commitment
      c.bodyRoll = Math.sin(w.time * 2.6) * 0.09 + Math.sin(w.time * 7.3) * 0.03;
      if (c.bhv.t > c.bhv.dur - 1 && w.rng() < dt * 3) c.legTuckT = 0;
    },
    exit(c) { c.legTuckT = 0; c.bodyRoll = 0; },
  },

  scream: {
    weight: 0.4, weird: true, dur: [3, 4.5], cooldown: 25,
    lines: ['{n} screamed. No reason was given.',
      '{n} let out a noise nobody asked for.',
      '{n} screamed and now everyone is looking.'],
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
    weight: 0, dur: [1.8, 3],
    enter(c) { c.stop(); },
    update(c, w, dt) {
      const at = c.bhv.data.at;
      if (at) c.facePoint(at.pos, dt, 6);
      c.headTiltT = 0.3;
    },
    exit(c) { c.headTiltT = 0; },
  },

  flightAttempt: {
    weight: 0.55, weird: true, dur: [5, 7], cooldown: 30,
    lines: ['{n} is preparing for takeoff.', '{n} believes she can fly.'],
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
        w.fx.puff(c.pos, 0x9a7f5c);
        say(w, c, ['{n} attempted flight. Physics won.',
          '{n} achieved 40 centimetres of altitude and a hard landing.',
          '{n} flew. Briefly. Badly.']);
      } else if (d.phase === 'landed') {
        c.bodyRoll *= Math.max(0, 1 - dt * 2.5);
        c.neckPitchT = 0.3; // dazed
      }
    },
    exit(c) { c.flapT = 0; c.bodyRoll = 0; c.neckPitchT = 0; },
  },

  // ---- behaviors that revolve around the matriarch ------------------------

  worship: {
    weight: 0.5, weird: true, dur: [8, 13], cooldown: 40,
    can(c, w) { return !!w.bertha; },
    lines: ['{n} is paying her respects to Big Bertha.',
      '{n} has gone to look upon Big Bertha.'],
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
    },
    exit(c) { c.neckPitchT = 0; },
  },

  rideBertha: {
    weight: 0.7, weird: true, dur: [12, 22], cooldown: 50,
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
          say(w, c, ['{n} leapt onto Big Bertha exactly as Big Bertha stood up.',
            '{n} mistimed the jump onto Big Bertha catastrophically.']);
          c.force('panic', { short: true });
          return;
        }
        d.phase = 'riding';
        c.mount(b, new THREE.Vector3(rand(w.rng, -0.22, 0.22), 0, rand(w.rng, -0.28, 0.28)));
        c.sitT = 0.35;
        w.audio.cluck(1.2);
        say(w, c, ['{n} has climbed on top of Big Bertha. This is a mistake.',
          '{n} is now standing on Big Bertha. Bertha has not noticed.',
          '{n} has claimed the summit of Big Bertha.']);
      } else if (d.phase === 'riding') {
        if (!c.riding) { c.bhv.t = c.bhv.dur; return; } // bucked off
        if (w.rng() < dt * 0.5) c.doPeck();
        if (w.rng() < dt * 0.3) c.headYawT = rand(w.rng, -0.9, 0.9);
      }
    },
    exit(c, w) {
      c.sitT = 0; c.headYawT = 0;
      if (c.riding) {
        c.dismount();
        if (w.rng() < 0.6) say(w, c, ['{n} has descended from Big Bertha.']);
      }
    },
  },
};

// ---- Big Bertha ------------------------------------------------------------
// She runs a separate table: mostly asleep, occasionally catastrophic.

export const BIG_BEHAVIORS = {

  bigSleep: {
    weight: 5, dur: [18, 32],
    lines: ['Big Bertha is asleep. The coop is at peace.',
      'Big Bertha has resumed sleeping. This is the natural order.'],
    quiet: 0.75,
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
    weight: 1.4, dur: [5, 8],
    lines: ['Big Bertha shifted in her sleep. Everyone froze.',
      'Big Bertha made a noise. Nothing further.',
      'Big Bertha almost woke up. The coop held its breath.'],
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
    weight: 1.5, weird: true, dur: [4.5, 5.5], cooldown: 30,
    lines: ['Big Bertha is waking up.', 'Something is happening. Big Bertha is moving.',
      'Big Bertha has opened her eyes.'],
    quiet: 0,
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
    weight: 0, dur: [3.5, 5],
    enter(c, w) {
      say(w, c, ['Big Bertha stood up, reconsidered, and is lying back down.',
        'Big Bertha surveyed the coop, found it acceptable, and sat.',
        'False alarm. Big Bertha has changed her mind.']);
      c.stop();
    },
    update(c, w, dt) { c.facePoint(w.camera.position, dt, 0.7); },
    next: 'bigSettle',
  },

  // THE RECKONING. She crosses the coop and everything gets out of the way.
  reckoning: {
    weight: 0, weird: true, chained: true, dur: [14, 20],
    enter(c, w) {
      say(w, c, ['Big Bertha is crossing the coop. Everyone has opinions about this.',
        'THE FLOOR IS SHAKING. It is just Big Bertha walking.',
        'Big Bertha is on the move. Clear the area.',
        'Big Bertha has decided to go somewhere. It is happening slowly.']);
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
          if (w.rng() < 0.12) say(w, o, ['{n} has yielded to Big Bertha.']);
        }
      }
      if (c.arrived(0.45)) {
        if (--c.bhv.data.legs > 0) {
          c.walkTo(randomPoint(w, 1.3), 0.42);
          if (w.rng() < 0.4) say(w, c, ['Big Bertha walked four feet and needs a moment.']);
        } else {
          c.bhv.t = c.bhv.dur;
        }
      }
    },
    exit(c) { c.stop(); },
    next: 'bigSettle',
  },

  // Lowering herself back down, with feeling.
  bigSettle: {
    weight: 0, dur: [4, 5],
    lines: ['Big Bertha is going back to sleep. The coop exhales.',
      'Big Bertha has completed her business and is lying down.'],
    quiet: 0.35,
    enter(c, w) { c.stop(); },
    update(c, w, dt) {
      c.sitT = Math.min(1, c.bhv.t / 2.6);
      c.lidT = Math.min(1, 0.2 + c.bhv.t / 3);
    },
    next: 'bigSleep',
  },

  // She eats. There is nothing left for anyone else.
  bigEat: {
    weight: 1.1, dur: [16, 22], cooldown: 60,
    lines: ['Big Bertha is going to the feeder. Everyone else can wait.'],
    quiet: 0.1,
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
        if (c.arrived(0.5)) {
          d.phase = 'eat';
          if (w.rng() < 0.8) say(w, c, ['Big Bertha has reached the feeder. It is hers now.']);
        }
      } else {
        c.facePoint(f, dt, 1.2);
        if (w.rng() < dt * 2) { c.doPeck(0.55); w.audio.cluck(0.55); }
      }
    },
    next: 'bigSettle',
  },

  // Being looked at, and looking back.
  bigStare: {
    weight: 0.9, weird: true, dur: [9, 14], cooldown: 45,
    lines: ['Big Bertha is looking at you. Directly.',
      'Big Bertha has noticed you and has not looked away.',
      'Big Bertha is awake and you are the reason.'],
    enter(c, w) { c.stop(); c.lidT = 0.05; },
    update(c, w, dt) {
      c.facePoint(w.camera.position, dt, 0.9); // she turns very, very slowly
      c.headTiltT = Math.sin(w.time * 0.35) * 0.22;
    },
    exit(c) { c.headTiltT = 0; },
    next: 'bigSettle',
  },

  // An earthquake with feathers.
  bigDustBath: {
    weight: 0.8, weird: true, dur: [12, 16], cooldown: 70,
    lines: ['Big Bertha is taking a dust bath. Structural concerns have been raised.',
      'Big Bertha is rolling in the dirt. The building is shaking.'],
    quiet: 0,
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
    next: 'bigSettle',
  },

  // Seeds are worth getting up for.
  bigSeedRush: {
    weight: 0, weird: true, chained: true, dur: [16, 22],
    enter(c, w) {
      c.buckOff();
      c.sitT = 0;
      c.lidT = 0.2;
      c.bhv.data.phase = 'rise';
      say(w, c, ['Big Bertha has smelled the seeds. She is getting up.',
        'Big Bertha is coming for the seeds. Move.']);
      w.audio.berthaGroan();
      w.incident();
    },
    update(c, w, dt) {
      const d = c.bhv.data;
      const patch = d.patch;
      if (!patch || patch.count <= 0) { c.bhv.t = c.bhv.dur; return; }
      if (d.phase === 'rise') {
        if (c.bhv.t > 2.4) { d.phase = 'walk'; }
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
          if (patch.count <= 0) say(w, c, ['Big Bertha ate all of it. Every seed. Gone.']);
        }
      }
    },
    next: 'bigSettle',
  },

  // You clicked her.
  bigGlare: {
    weight: 0, dur: [5, 7],
    enter(c, w) {
      c.lidT = 0.35;
      say(w, c, ['Big Bertha opened one eye. You have been noted.',
        'Big Bertha is aware of what you did.',
        'Big Bertha does not appreciate being poked.']);
      w.audio.berthaGroan(0.8);
    },
    update(c, w, dt) { c.facePoint(w.camera.position, dt, 0.8); },
    // Poke her enough and she gets up. That is on you.
    next: (c, w) => (w.rng() < 0.35 ? 'bigRise' : 'bigSleep'),
  },
};

// ---- state machine plumbing ------------------------------------------------

const TABLES = { normal: BEHAVIORS, big: BIG_BEHAVIORS };
const PICKABLE = {
  normal: Object.entries(BEHAVIORS).filter(([, d]) => d.weight > 0),
  big: Object.entries(BIG_BEHAVIORS).filter(([, d]) => d.weight > 0),
};

// Bertha cannot be startled, seeded, or chased like an ordinary chicken;
// requests aimed at her get translated or dropped.
const BIG_ALIASES = { seedRush: 'bigSeedRush', wander: 'bigSettle', panic: null, flee: null, lookAt: null };

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
  if (def.lines && w.rng() > (def.quiet ?? 0.25)) say(w, c, def.lines);
  def.enter?.(c, w);
  return c.bhv;
}
