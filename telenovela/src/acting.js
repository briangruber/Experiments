// The acting layer. One Actor wraps one rig and turns direction ("gasp",
// "storm over there", "look at her") into channel values. Everything is
// additive: idle < emotion < look < gesture < locomotion.

import * as THREE from '../vendor/three/three.module.min.js';
import { REST, applyPose, placeFeet } from './chicken.js';
import { ENV_HZ } from './dialogue-timing.js';
import { TAU, clamp, clamp01, lerp, lerpAngle, approach, deg, ease, fbm1, mulberry32 } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

// --- gesture library --------------------------------------------------------
// Each entry: { dur, apply(p, u, w, self) } where u is 0..1 through the gesture
// and w is a fade weight. `self` is the actor, so a gesture can read emotion or
// fire an event at a precise beat.

export const GESTURES = {
  // The telenovela gasp: everything recoils, nothing is subtle.
  gasp: {
    dur: 1.5,
    apply(p, u, w, self) {
      const k = ease.flinch(u) * w;
      p.neckExtend += k * 0.85;
      p.headPitch += k * -0.42;
      p.bodyPitch += k * -0.16;
      p.bodyZ += k * -0.05;
      p.beak += k * 0.9;
      p.lid += k * -0.28;
      p.browHeight += k * 1.0;
      p.browAngle += k * -0.18;
      p.wingLLift += k * 0.55; p.wingRLift += k * 0.55;
      p.wingSpread += k * 0.6;
      p.puff += k * 0.5;
      if (u < 0.05) self.shockHold = 1;
    },
  },
  // Head snaps to a subject, back, then snaps again — the double take.
  doubleTake: {
    dur: 1.9,
    apply(p, u, w) {
      const seq = u < 0.16 ? ease.expoOut(u / 0.16)
        : u < 0.34 ? 1 - ease.expoOut((u - 0.16) / 0.18) * 0.95
          : u < 0.5 ? 0.05 + ease.expoOut((u - 0.34) / 0.16) * 1.15
            : 1.2 - ease.in((u - 0.5) / 0.5) * 1.2;
      p.headYaw += seq * w * 0.0; // yaw comes from the look-at target
      p.neckExtend += seq * w * 0.5;
      p.lid += seq * w * -0.2;
      p.browHeight += seq * w * 0.8;
      p.headZ += seq * w * 0.035;
    },
  },
  // Wing across the face, in slow motion, from the shoulder.
  slap: {
    dur: 1.25,
    apply(p, u, w, self) {
      const wind = u < 0.42 ? ease.cubicIn(u / 0.42) : 0;
      const swing = u >= 0.42 ? ease.expoOut(clamp01((u - 0.42) / 0.16)) : 0;
      const follow = u >= 0.58 ? ease.cubicOut((u - 0.58) / 0.42) : 0;
      const side = self.slapSide ?? 1;
      const L = side < 0 ? 1 : 0, R = side < 0 ? 0 : 1;
      const arm = wind * -1 + swing * 1.9 - follow * 0.55;
      p.wingLLift += L * (0.5 + Math.abs(arm) * 0.7) * w;
      p.wingRLift += R * (0.5 + Math.abs(arm) * 0.7) * w;
      p.wingLSweep += L * arm * -1.5 * w;
      p.wingRSweep += R * arm * -1.5 * w;
      p.wingSpread += (wind * 0.3 + swing * 0.9) * w;
      p.bodyYaw += side * (wind * 0.18 - swing * 0.42 + follow * 0.16) * w;
      p.bodyPitch += (wind * -0.1 + swing * 0.14) * w;
      p.browAngle += (wind + swing) * 0.5 * w;
      p.beak += swing * 0.5 * w;
      if (!self._slapFired && u >= 0.55) { self._slapFired = true; self.emit('slap'); }
      if (u < 0.05) self._slapFired = false;
    },
  },
  // Taking one. Head whips, body twists, one leg gives.
  slapped: {
    dur: 2.2,
    apply(p, u, w, self) {
      const hit = ease.expoOut(clamp01(u / 0.09));
      const rec = u > 0.35 ? ease.cubicOut((u - 0.35) / 0.65) : 0;
      const k = (hit - rec) * w;
      const side = self.slapFrom ?? 1;
      p.headYaw += side * k * 1.05;
      p.headRoll += side * k * 0.5;
      p.neckPitch += k * 0.2;
      p.bodyYaw += side * k * 0.3;
      p.bodyRoll += side * k * 0.16;
      p.bodyPitch += k * 0.2;
      p.lid += k * 0.55;
      p.beak += k * 0.45;
      p.wingLLift += k * 0.5; p.wingRLift += k * 0.5;
      p.wingLSweep += k * 0.4; p.wingRSweep += k * 0.4;
      p.tailPitch += k * 0.3;
    },
  },
  // Wing to the brow, head back: the swoon that precedes the faint.
  swoon: {
    dur: 2.6,
    apply(p, u, w, self) {
      const k = ease.pulse(Math.pow(u, 0.7)) * w;
      const side = self.swoonSide ?? -1;
      const L = side < 0 ? 1 : 0, R = side < 0 ? 0 : 1;
      p.wingLLift += L * k * 1.5; p.wingRLift += R * k * 1.5;
      p.wingLSweep += L * k * 1.1; p.wingRSweep += R * k * 1.1;
      p.wingLTwist += L * k * 0.9; p.wingRTwist += R * k * 0.9;
      p.headPitch += k * -0.55;
      p.headRoll += -side * k * 0.35;
      p.neckExtend += k * 0.4;
      p.bodyPitch += k * -0.22;
      p.lid += k * 0.5;
      p.browAngle += k * -0.35;
      p.beak += k * 0.3;
    },
  },
  // The full faint. Ends in a held collapse — the actor stays down until told
  // otherwise, because getting up would spoil the act break.
  faint: {
    dur: 1.8, hold: true,
    apply(p, u, w, self) {
      const fall = ease.cubicIn(clamp01(u / 0.55));
      const settle = u > 0.55 ? ease.elasticOut((u - 0.55) / 0.45) : 0;
      const k = (fall + settle * 0.06) * w;
      const side = self.swoonSide ?? -1;
      p.bodyY += k * -0.24;
      p.bodyRoll += side * k * 1.15;
      p.bodyPitch += k * -0.55;
      p.headPitch += k * -0.5;
      p.headRoll += side * k * 0.7;
      p.neckExtend += k * 0.25 * (1 - fall * 0.5);
      p.lid += clamp01(u / 0.3) * w;
      p.wingLLift += k * 0.75; p.wingRLift += k * 0.75;
      p.wingSpread += k * 0.5;
      p.tailPitch += k * 0.4;
      p.legLift += k;
      self.collapsedAmount = k;
    },
  },
  // Catching her. Wings forward, knees bent, body low.
  catcher: {
    dur: 2.0, hold: true,
    apply(p, u, w) {
      const k = ease.quartOut(clamp01(u / 0.35)) * w;
      p.wingLLift += k * 1.25; p.wingRLift += k * 1.25;
      p.wingLSweep += k * -0.95; p.wingRSweep += k * -0.95;
      p.wingSpread += k * 0.7;
      p.bodyPitch += k * 0.3;
      p.bodyY += k * -0.09;
      p.headPitch += k * 0.32;
      p.neckExtend += k * 0.3;
      p.browAngle += k * -0.3;
      p.beak += k * 0.35;
    },
  },
  // Head thrown back, beak wide, shoulders shaking. Silent, and audible anyway.
  laugh: {
    dur: 3.2,
    apply(p, u, w) {
      const env = ease.pulse(u) * w;
      const shake = Math.sin(u * TAU * 7.5);
      p.headPitch += env * (-0.5 + shake * 0.16);
      p.neckExtend += env * 0.5;
      p.beak += env * (0.6 + shake * 0.4);
      p.bodyPitch += env * (-0.2 + shake * 0.06);
      p.bodyY += env * shake * 0.012;
      p.wingLLift += env * (0.45 + shake * 0.12);
      p.wingRLift += env * (0.45 + shake * 0.12);
      p.lid += env * 0.4;
      p.browAngle += env * -0.2;
      p.puff += env * 0.4;
      p.tailPitch += env * -0.2;
    },
  },
  // Silent weeping: head down, wing over the eyes, a jolt on every breath.
  sob: {
    dur: 4.0,
    apply(p, u, w, self) {
      const env = Math.min(1, ease.pulse(u) * 1.6) * w;
      const jolt = Math.pow(Math.max(0, Math.sin(u * TAU * 3.1)), 6);
      const side = self.swoonSide ?? -1;
      const L = side < 0 ? 1 : 0, R = side < 0 ? 0 : 1;
      p.headPitch += env * (0.55 + jolt * 0.2);
      p.neckPitch += env * 0.28;
      p.bodyPitch += env * (0.25 + jolt * 0.12);
      p.bodyY += env * (-0.03 - jolt * 0.02);
      p.lid += env * 0.6;
      p.browAngle += env * -0.45;
      p.browHeight += env * 0.5;
      p.wingLLift += L * env * 1.35 + R * env * 0.2;
      p.wingRLift += R * env * 1.35 + L * env * 0.2;
      p.wingLSweep += L * env * 0.95; p.wingRSweep += R * env * 0.95;
      p.puff += env * 0.3;
    },
  },
  // A wing thrust out in accusation.
  accuse: {
    dur: 2.4,
    apply(p, u, w, self) {
      const k = (u < 0.18 ? ease.backOut(u / 0.18) : 1 - ease.cubicIn(clamp01((u - 0.7) / 0.3))) * w;
      const side = self.pointSide ?? 1;
      const L = side < 0 ? 1 : 0, R = side < 0 ? 0 : 1;
      p.wingLLift += L * k * 1.55; p.wingRLift += R * k * 1.55;
      p.wingLSweep += L * k * -1.15; p.wingRSweep += R * k * -1.15;
      p.wingLTwist += L * k * -0.4; p.wingRTwist += R * k * -0.4;
      p.wingSpread += k * 0.75;
      p.bodyPitch += k * 0.16;
      p.bodyZ += k * 0.03;
      p.neckExtend += k * 0.5;
      p.browAngle += k * 0.55;
      p.beak += k * 0.55;
      p.puff += k * 0.35;
    },
  },
  // Chest out, wings cocked, tail up. Pure rooster.
  strutPose: {
    dur: 2.6,
    apply(p, u, w) {
      const k = ease.pulse(Math.pow(u, 0.8)) * w;
      p.bodyPitch += k * -0.2;
      p.neckExtend += k * 0.55;
      p.puff += k * 0.7;
      p.wingLLift += k * 0.35; p.wingRLift += k * 0.35;
      p.tailPitch += k * -0.4;
      p.tailFan += k * 0.5;
      p.browAngle += k * 0.12;
      p.headPitch += k * 0.1;
    },
  },
  // Crowing. Whole body committed.
  crow: {
    dur: 2.2,
    apply(p, u, w, self) {
      const wind = u < 0.22 ? ease.cubicOut(u / 0.22) : 1;
      const call = u >= 0.22 && u < 0.72 ? ease.expoOut((u - 0.22) / 0.14) : 0;
      const out = u >= 0.72 ? ease.cubicIn((u - 0.72) / 0.28) : 0;
      const k = (wind * 0.35 + call - out) * w;
      p.neckExtend += k * 1.3;
      p.headPitch += k * -0.62;
      p.beak += k * 1.0;
      p.bodyPitch += k * -0.22;
      p.puff += k * 0.8;
      p.wingLLift += k * 0.5; p.wingRLift += k * 0.5;
      p.tailPitch += k * -0.3;
      if (!self._crowFired && u >= 0.24) { self._crowFired = true; self.emit('crow'); }
      if (u < 0.05) self._crowFired = false;
    },
  },
  // Eyes narrow, head lowers, hackles rise. The villainess considers her move.
  scheme: {
    dur: 3.0,
    apply(p, u, w) {
      const k = ease.pulse(Math.pow(u, 0.6)) * w;
      p.lid += k * 0.4;
      p.lidAngle += k * 0.8;
      p.browAngle += k * 0.75;
      p.browHeight += k * -0.6;
      p.headPitch += k * 0.2;
      p.neckPitch += k * 0.12;
      p.puff += k * 0.35;
      p.bodyPitch += k * 0.08;
    },
  },
  // Leaning in. Lids heavy, head tilted, beak nearly touching.
  nuzzle: {
    dur: 3.4, hold: true,
    apply(p, u, w) {
      const k = ease.quartOut(clamp01(u / 0.5)) * w;
      p.neckExtend += k * 0.55;
      p.headPitch += k * -0.12;
      p.headRoll += k * 0.3;
      p.bodyPitch += k * -0.08;
      p.bodyZ += k * 0.05;
      p.lid += k * 0.36;
      p.browAngle += k * -0.28;
      p.browHeight += k * 0.2;
      p.wingLLift += k * 0.16; p.wingRLift += k * 0.16;
    },
  },
  // Recoiling a step without moving the feet.
  recoil: {
    dur: 1.4,
    apply(p, u, w) {
      const k = ease.flinch(u) * w;
      p.bodyZ += k * -0.07;
      p.bodyPitch += k * -0.1;
      p.neckPitch += k * -0.2;
      p.headPitch += k * -0.15;
      p.lid += k * -0.2;
      p.browHeight += k * 0.7;
      p.wingLLift += k * 0.4; p.wingRLift += k * 0.4;
    },
  },
  // A tremor that runs through the whole bird.
  shudder: {
    dur: 1.6,
    apply(p, u, w) {
      const env = ease.pulse(u) * w;
      const f = Math.sin(u * TAU * 11);
      p.bodyRoll += env * f * 0.05;
      p.headRoll += env * f * 0.09;
      p.puff += env * 0.55;
      p.lid += env * 0.25;
    },
  },
  // Turning the back on someone. The full body says it.
  spurn: {
    dur: 2.8, hold: true,
    apply(p, u, w) {
      const k = ease.quartOut(clamp01(u / 0.4)) * w;
      p.headPitch += k * -0.28;
      p.neckExtend += k * 0.25;
      p.lid += k * 0.4;
      p.browAngle += k * -0.15;
      p.bodyPitch += k * -0.1;
      p.tailPitch += k * -0.15;
    },
  },
  // A long breath out. The whole chest does it.
  sigh: {
    dur: 3.2,
    apply(p, u, w) {
      const rise = ease.cubicOut(clamp01(u / 0.3));
      const fall = u > 0.3 ? ease.cubicIn(clamp01((u - 0.3) / 0.5)) : 0;
      const k = (rise - fall) * w;
      p.puff += k * 0.9;
      p.neckExtend += k * 0.35;
      p.headPitch += k * -0.12 + fall * w * 0.35;
      p.bodyY += k * 0.018 - fall * w * 0.022;
      p.bodyPitch += fall * w * 0.14;
      p.lid += rise * w * 0.5 + fall * w * 0.2;
      p.browAngle += k * -0.3;
      p.beak += k * 0.18;
    },
  },
  // Curtain call. Chickens cannot bow, so this is a deep forward pitch with
  // the wings fanned, which is close enough to bring the house down.
  bow: {
    dur: 2.4,
    apply(p, u, w) {
      const k = ease.pulse(Math.pow(u, 0.72)) * w;
      p.bodyPitch += k * 0.6;
      p.bodyY += k * -0.07;
      p.neckPitch += k * 0.42;
      p.headPitch += k * 0.3;
      p.wingLLift += k * 0.7; p.wingRLift += k * 0.7;
      p.wingLSweep += k * -0.55; p.wingRSweep += k * -0.55;
      p.wingSpread += k * 0.85;
      p.tailPitch += k * -0.4;
      p.tailFan += k * 0.5;
      p.lid += k * 0.22;
    },
  },
  peck: {
    dur: 0.75,
    apply(p, u, w) {
      const k = ease.pulse(Math.pow(u, 0.6)) * w;
      p.neckPitch += k * 0.85;
      p.headPitch += k * 0.5;
      p.bodyPitch += k * 0.14;
      p.beak += k * 0.5;
    },
  },
  // Head cocked, the way a bird examines something it does not trust.
  cock: {
    dur: 1.8,
    apply(p, u, w, self) {
      const k = ease.pulse(Math.pow(u, 0.5)) * w;
      p.headRoll += (self.cockSide ?? 1) * k * 0.85;
      p.neckExtend += k * 0.25;
      p.browHeight += k * 0.35;
    },
  },
};

// --- the actor --------------------------------------------------------------

let ACTOR_SEED = 1;

export class Actor {
  constructor(rig) {
    this.rig = rig;
    this.name = rig.name;
    this.root = rig.root;
    this.size = rig.size;
    this.rng = mulberry32(ACTOR_SEED++ * 9781);
    this.seed = this.rng() * 100;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.turnRate = 3.2;

    this.emotion = { anger: 0, sorrow: 0, love: 0, fear: 0, pride: 0, shock: 0 };
    this.emotionTarget = { ...this.emotion };
    this.emotionRate = 2.2;

    this.lookTarget = null;      // Vector3 or Actor
    this.lookWeight = 0;
    this.lookWeightTarget = 0;
    this._lookYaw = 0; this._lookPitch = 0;

    this.gestures = [];
    this.listeners = {};

    this.path = null;
    this.gait = 0;
    this.speed = 0;
    this.collapsedAmount = 0;
    this.shockHold = 0;
    this.blinkAt = 1 + this.rng() * 3;
    this.blink = 0;
    this.visible = true;

    // Foot bookkeeping in world space so planted feet stay planted.
    this.feet = [
      { world: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), planted: true },
      { world: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), planted: true },
    ];
    this._footTmp = [new THREE.Vector3(), new THREE.Vector3()];
    this.resetFeet();
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  // Set for the rest of the frame so the gesture that emitted it can pick it
  // up; the gesture loop clears it.
  emit(evt) { this._beat = evt; for (const f of this.listeners[evt] || []) f(this); }

  get object() { return this.root; }

  setVisible(v) { this.visible = v; this.root.visible = v; return this; }

  place(x, z, yaw = 0) {
    this.pos.set(x, 0, z);
    this.yaw = this.targetYaw = yaw;
    this.path = null; this.speed = 0; this.gait = 0;
    this.resetFeet();
    return this;
  }

  resetFeet() {
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      this.footHome(sx, this._footTmp[0]);
      this.feet[i].world.copy(this._footTmp[0]);
      this.feet[i].planted = true;
    }
  }

  footHome(sx, out, ahead = 0) {
    const o = 0.062 * this.size;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const lx = sx * o, lz = -0.015 * this.size + ahead;
    return out.set(this.pos.x + lx * c + lz * s, 0, this.pos.z - lx * s + lz * c);
  }

  // --- direction ------------------------------------------------------------

  emote(vals, rate = 2.2) {
    Object.assign(this.emotionTarget, vals);
    this.emotionRate = rate;
    return this;
  }
  setEmotion(vals) {
    Object.assign(this.emotionTarget, vals);
    Object.assign(this.emotion, this.emotionTarget);
    return this;
  }
  calm(rate = 1.4) {
    return this.emote({ anger: 0, sorrow: 0, love: 0, fear: 0, pride: 0, shock: 0 }, rate);
  }

  gesture(name, opts = {}) {
    const g = GESTURES[name];
    if (!g) { console.warn('unknown gesture', name); return this; }
    if (opts.side !== undefined) {
      this.slapSide = this.swoonSide = this.pointSide = this.cockSide = opts.side;
    }
    this.gestures = this.gestures.filter((x) => x.name !== name);
    this.gestures.push({
      name, def: g, t: -(opts.delay ?? 0),
      dur: (opts.dur ?? g.dur) * (opts.scale ?? 1),
      weight: opts.weight ?? 1, hold: opts.hold ?? g.hold ?? false, fade: 0,
      // Fires at the gesture's own beat — the frame the wing connects, or the
      // beak opens — rather than at whatever second the cue was written on.
      onBeat: opts.onBeat ?? null,
    });
    return this;
  }
  release(name) {
    for (const g of this.gestures) if (!name || g.name === name) g.releasing = true;
    return this;
  }
  clearGestures() { this.gestures.length = 0; this.collapsedAmount = 0; return this; }

  // Say a line. `env` is the baked loudness envelope from tools/voices.mjs and
  // `dur` its length in REAL seconds — speech runs on the wall clock, not the
  // scene clock, because the recording does. That distinction is the whole
  // reason updateSpeech takes its own dt: during the slap the director drops
  // the world to a fifth speed and freezes a frame, and a mouth that slowed
  // down with it would drift a second behind its own voice.
  speak(env, dur) {
    this.speech = { env, dur, t: 0 };
    return this;
  }
  hush() { this.speech = null; return this; }

  look(target, weight = 1) {
    this.lookTarget = target;
    this.lookWeightTarget = weight;
    return this;
  }
  lookAway() { this.lookWeightTarget = 0; return this; }

  face(target, snap = false) {
    const p = target && target.pos ? target.pos : target;
    if (p instanceof THREE.Vector3) {
      this.targetYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
    } else if (typeof target === 'number') {
      this.targetYaw = target;
    }
    if (snap) this.yaw = this.targetYaw;
    return this;
  }

  // Walk to a spot. `style` changes the gait, not the path.
  walkTo(x, z, opts = {}) {
    const from = this.pos.clone();
    const to = new THREE.Vector3(x, 0, z);
    const dist = from.distanceTo(to);
    const style = opts.style ?? 'walk';
    const base = { walk: 0.62, strut: 0.5, storm: 1.15, hurry: 0.95, shuffle: 0.34 }[style] ?? 0.62;
    const speed = (opts.speed ?? base) * this.size;
    this.path = {
      from, to, dist, style, t: 0,
      dur: Math.max(0.35, dist / Math.max(0.05, speed)),
      easeIn: opts.easeIn ?? 0.22, easeOut: opts.easeOut ?? 0.28,
      faceEnd: opts.face, arrive: opts.arrive,
    };
    if (dist > 0.02) this.face(to);
    return this;
  }
  stop() { this.path = null; return this; }

  // --- world queries used by the camera --------------------------------------

  headWorld(out = new THREE.Vector3()) { return this.rig.head.getWorldPosition(out); }
  // Where the face is actually pointing, neck and look-at included. Close-ups
  // frame off this rather than the body, or an actor looking over her shoulder
  // gets shot from behind the skull.
  headYaw() {
    const m = this.rig.head.matrixWorld.elements;
    return Math.atan2(m[8], m[10]);
  }
  eyeWorld(out = new THREE.Vector3(), from = null) {
    // Always the eye nearer the camera, or a three-quarter close-up frames the
    // far eye and pushes the near one off the edge.
    if (!from) return this.rig.eyes[1].group.getWorldPosition(out);
    const a = this.rig.eyes[0].group.getWorldPosition(_a);
    const b = this.rig.eyes[1].group.getWorldPosition(_b);
    return out.copy(a.distanceToSquared(from) <= b.distanceToSquared(from) ? a : b);
  }
  chestWorld(out = new THREE.Vector3()) {
    return out.copy(this.rig.neck.getWorldPosition(_c)).lerp(this.rig.body.getWorldPosition(_a), 0.45);
  }
  bodyWorld(out = new THREE.Vector3()) { return this.rig.body.getWorldPosition(out); }
  // Camera framing uses this as "how tall is the subject".
  get standHeight() { return 0.52 * this.size * (1 - this.collapsedAmount * 0.6); }

  // --- per-frame -------------------------------------------------------------

  update(dt, time, rdt) {
    if (!this.visible) return;
    const p = REST();
    const rig = this.rig;

    // 1. locomotion
    this.updatePath(dt);

    // 2. emotion smoothing
    for (const k in this.emotion) {
      this.emotion[k] = approach(this.emotion[k], this.emotionTarget[k], this.emotionRate, dt);
    }
    this.shockHold = Math.max(0, this.shockHold - dt * 0.55);

    // 3. idle: breathing, weight shift, feather settle, blink
    this.idlePose(p, time, dt);

    // 4. emotion -> channels
    this.emotionPose(p);

    // 5. look-at
    this.lookPose(p, dt);

    // 6. gestures on top
    for (let i = this.gestures.length - 1; i >= 0; i--) {
      const g = this.gestures[i];
      g.t += dt;
      if (g.t < 0) continue;
      const u = g.hold ? Math.min(1, g.t / g.dur) : g.t / g.dur;
      if (!g.hold && u >= 1) { this.gestures.splice(i, 1); continue; }
      if (g.releasing) {
        g.fade = Math.max(0, g.fade - dt / 0.6);
        if (g.fade <= 0) { this.gestures.splice(i, 1); if (g.name === 'faint') this.collapsedAmount = 0; continue; }
      } else {
        g.fade = Math.min(1, g.fade + dt / 0.12);
      }
      this._beat = null;
      g.def.apply(p, clamp01(u), g.weight * g.fade, this);
      if (this._beat && g.onBeat) { const fn = g.onBeat; g.onBeat = null; fn(this._beat, this); }
    }

    // 6.5 speech. The beak tracks the loudness of the line, so a hard
    // consonant snaps it shut and a held vowel holds it open.
    this.jawPose(p, rdt ?? dt);

    // 7. commit (the gait overlay is applied after posing, in updateFeet)
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    applyPose(rig, p, dt);
    this.updateFeet(dt);
    this.pose = p;
  }

  jawPose(p, dt) {
    let target = 0;
    const s = this.speech;
    if (s) {
      s.t += dt;
      if (s.t >= s.dur) this.speech = null;
      else if (s.env.length) {
        const i = Math.min(s.env.length - 1, Math.floor(s.t * ENV_HZ));
        target = (s.env.charCodeAt(i) - 48) / 9;
      }
    }
    // Fast enough to catch a syllable, slow enough that the jaw has mass.
    this.jaw = approach(this.jaw ?? 0, target, 26, dt);
    if (this.jaw < 0.004) return;
    p.beak += this.jaw * 0.95;
    // A bird talking moves more than its beak.
    p.neckExtend += this.jaw * 0.05;
    p.headPitch += this.jaw * -0.045;
    p.wattleSwing = (p.wattleSwing ?? 0) + this.jaw * 0.1;
  }

  updatePath(dt) {
    const path = this.path;
    if (!path) { this.speed = approach(this.speed, 0, 8, dt); this.yaw = lerpAngle(this.yaw, this.targetYaw, 1 - Math.exp(-this.turnRate * dt)); return; }
    path.t += dt;
    const raw = clamp01(path.t / path.dur);
    // Ease in and out of the walk without changing where the feet land.
    const eIn = path.easeIn, eOut = path.easeOut;
    let u;
    if (raw < eIn) u = (raw * raw) / (2 * eIn);
    else if (raw > 1 - eOut) { const r = (1 - raw) / eOut; u = 1 - (r * r * eOut) / 2; }
    else u = raw - eIn / 2;
    const total = 1 - eIn / 2 - eOut / 2;
    const f = clamp01(u / total);
    const prev = this.pos.clone();
    this.pos.lerpVectors(path.from, path.to, f);
    this.speed = prev.distanceTo(this.pos) / Math.max(dt, 1e-4);
    if (raw > 0.82 && path.faceEnd !== undefined) {
      this.face(path.faceEnd);
    }
    this.yaw = lerpAngle(this.yaw, this.targetYaw, 1 - Math.exp(-this.turnRate * dt));
    if (raw >= 1) { this.path = null; this.speed = 0; if (path.arrive) path.arrive(this); }
  }

  idlePose(p, time, dt) {
    const t = time + this.seed;
    const breath = Math.sin(t * 1.35) * 0.5 + fbm1(t * 0.4, 3) * 0.5;
    const calm = 1 - clamp01(this.emotion.fear + this.emotion.anger * 0.6);
    p.bodyY += breath * 0.006 * (0.5 + calm);
    p.puff += 0.05 + breath * 0.05;
    p.neckExtend += fbm1(t * 0.55, 1) * 0.06;
    p.headYaw += fbm1(t * 0.62, 2) * 0.09 * calm;
    p.headPitch += fbm1(t * 0.7, 5) * 0.05;
    p.headRoll += fbm1(t * 0.33, 6) * 0.04;
    p.bodyRoll += fbm1(t * 0.29, 7) * 0.02;
    p.tailPitch += fbm1(t * 0.5, 8) * 0.07;
    p.tailFan += 0.06 + fbm1(t * 0.8, 9) * 0.05;

    // Chickens hold still, then move all at once. A small chance per second of
    // a head flick keeps them from looking like they are floating.
    if (this.rng() < dt * 0.55 && this.gestures.length === 0 && !this.path) {
      this.gesture(this.rng() < 0.35 ? 'peck' : 'cock', { weight: 0.35 + this.rng() * 0.3 });
      this.cockSide = this.rng() < 0.5 ? -1 : 1;
    }

    // Blink. Fear widens the eyes and suppresses it.
    this.blinkAt -= dt * (1 - this.emotion.fear * 0.7 - this.shockHold * 0.9);
    if (this.blinkAt <= 0) { this.blink = 1; this.blinkAt = 2.2 + this.rng() * 4.5; }
    if (this.blink > 0) {
      this.blink = Math.max(0, this.blink - dt / 0.16);
      p.lid += Math.sin((1 - this.blink) * Math.PI) * 0.95;
    }
  }

  emotionPose(p) {
    const e = this.emotion;
    // anger: brows down and in, head low and forward, hackles up, tail up
    p.browAngle += e.anger * 0.75 - e.sorrow * 0.55 - e.love * 0.3 + e.fear * -0.25;
    p.browHeight += -e.anger * 0.5 + e.sorrow * 0.35 + e.fear * 0.9 + e.shock * 1.0;
    p.lid += -e.anger * 0.08 + e.sorrow * 0.2 + e.love * 0.14 - e.fear * 0.22 - e.shock * 0.3;
    p.lidAngle += e.anger * 0.55;
    p.neckExtend += e.anger * 0.3 + e.pride * 0.55 - e.sorrow * 0.25 + e.shock * 0.4 - e.fear * 0.15;
    p.neckPitch += e.sorrow * 0.3 - e.pride * 0.12 + e.anger * 0.1;
    p.headPitch += e.sorrow * 0.32 - e.pride * 0.2 - e.shock * 0.18 + e.anger * 0.14;
    p.bodyPitch += e.anger * 0.12 + e.sorrow * 0.16 - e.pride * 0.14 - e.fear * 0.1;
    p.bodyY += -e.sorrow * 0.02 - e.fear * 0.03 + e.pride * 0.02;
    p.puff += e.anger * 0.55 + e.fear * 0.75 + e.pride * 0.5 - e.sorrow * 0.2;
    p.tailPitch += -e.anger * 0.3 - e.pride * 0.45 + e.sorrow * 0.5 + e.fear * 0.4;
    p.tailFan += e.anger * 0.35 + e.pride * 0.6 - e.sorrow * 0.3;
    p.wingLLift += e.fear * 0.3 + e.anger * 0.22;
    p.wingRLift += e.fear * 0.3 + e.anger * 0.22;
    p.wingSpread += e.anger * 0.3 + e.fear * 0.35;
    p.beak += e.anger * 0.12 + e.shock * 0.3;
    p.eyeY += e.sorrow * -0.5 + e.shock * 0.3;
  }

  lookPose(p, dt) {
    this.lookWeight = approach(this.lookWeight, this.lookWeightTarget, 3.6, dt);
    if (this.lookWeight < 0.004 || !this.lookTarget) return;
    const lt = this.lookTarget;
    const tp = lt.headWorld ? lt.headWorld(_b)
      : lt.isVector3 ? _b.copy(lt)
        : lt.getWorldPosition ? lt.getWorldPosition(_b) : _b.copy(lt);
    this.rig.head.getWorldPosition(_a);
    const dx = tp.x - _a.x, dy = tp.y - _a.y, dz = tp.z - _a.z;
    const flat = Math.hypot(dx, dz);
    let yaw = Math.atan2(dx, dz) - this.yaw;
    while (yaw > Math.PI) yaw -= TAU;
    while (yaw < -Math.PI) yaw += TAU;
    const pitch = -Math.atan2(dy, Math.max(0.05, flat));
    const w = this.lookWeight;
    // Split the turn between neck and skull, and let the body cheat a little
    // when the target is behind the shoulder.
    const yClamped = clamp(yaw, -2.2, 2.2);
    this._lookYaw = approach(this._lookYaw, yClamped, 7, dt);
    this._lookPitch = approach(this._lookPitch, clamp(pitch, -0.8, 0.9), 7, dt);
    p.neckYaw += this._lookYaw * 0.34 * w;
    p.headYaw += clamp(this._lookYaw * 0.66, -1.25, 1.25) * w;
    p.bodyYaw += clamp(this._lookYaw, -1.4, 1.4) * 0.16 * w;
    p.headPitch += this._lookPitch * 0.7 * w;
    p.neckPitch += this._lookPitch * 0.3 * w;
    p.eyeX += clamp(this._lookYaw, -1, 1) * 0.6 * w;
  }

  updateFeet(dt) {
    const rig = this.rig, s = this.size;
    const style = this.path?.style ?? 'walk';
    const stride = ({ walk: 0.22, strut: 0.26, storm: 0.3, hurry: 0.24, shuffle: 0.14 }[style] ?? 0.22) * s;
    const moving = this.speed > 0.03;
    if (moving) this.gait += (this.speed * dt) / stride;
    else this.gait += dt * 0.0;

    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const sx = i === 0 ? -1 : 1;
      const phase = (this.gait + (i === 0 ? 0 : 0.5)) % 1;
      if (moving) {
        const swing = phase > 0.55;
        if (swing && foot.planted) {
          foot.planted = false;
          foot.from.copy(foot.world);
          this.footHome(sx, foot.to, stride * 0.55);
        } else if (!swing && !foot.planted) {
          foot.planted = true;
          foot.world.copy(foot.to);
        }
        if (!foot.planted) {
          const u = clamp01((phase - 0.55) / 0.45);
          // Retarget mid-swing so a turning bird doesn't cross its own legs.
          this.footHome(sx, _a, stride * 0.55);
          foot.to.lerp(_a, 0.25);
          foot.world.lerpVectors(foot.from, foot.to, ease.inOut(u));
          foot.world.y = Math.sin(u * Math.PI) * 0.075 * s;
        }
      } else if (!foot.planted) {
        foot.planted = true;
      } else {
        // Standing: creep the foot back to home so turns don't shear the legs.
        this.footHome(sx, _a);
        foot.world.lerp(_a, 1 - Math.exp(-6 * dt));
        foot.world.y = 0;
      }
      void c; void sn;
    }

    // Body bob and head stabilisation, both driven by the same gait phase.
    if (moving || this.speed > 0.001) {
      const g = this.gait % 1;
      const bob = Math.sin(g * TAU * 2) * 0.5 + 0.5;
      const sway = Math.sin(g * TAU);
      const amp = clamp01(this.speed / (0.8 * s));
      rig.body.position.y += (bob * 0.022 - 0.008) * s * amp;
      rig.body.rotation.z += sway * 0.07 * amp;
      rig.body.rotation.y += sway * 0.05 * amp;
      // The famous head-hold: the skull stays put in world space, then darts.
      const u = g % 1;
      const thrust = u < 0.22 ? ease.expoOut(u / 0.22) : 1 - (u - 0.22) / 0.78;
      rig.head.position.z += (thrust - 0.5) * 0.055 * s * amp;
      rig.head.position.y += Math.sin(u * TAU) * 0.004 * s * amp;
    }

    const t0 = this._footTmp[0], t1 = this._footTmp[1];
    t0.copy(this.feet[0].world); t1.copy(this.feet[1].world);
    // Legs are solved in the body's local frame, so lean and roll come for free.
    rig.body.updateWorldMatrix(true, false);
    rig.body.worldToLocal(t0);
    rig.body.worldToLocal(t1);
    placeFeet(rig, [t0, t1]);
  }
}
