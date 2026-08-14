// The cinematographer. The director asks for a shot in film terms — subject,
// framing, lens, angle, move — and this works out where to put the camera and
// how to get there.

import * as THREE from '../vendor/three/three.module.min.js';
import { clamp, clamp01, lerp, lerpAngle, approach, deg, ease, fbm1, Spring, TAU } from './util.js';

const SENSOR_H = 24; // mm — full-frame vertical, so lens numbers read normally

// Wide shots are framed off the subject's full height; anything from a medium
// close-up in is framed off the head, or a chick gets an unusable macro shot.
const FRAMING_BODY = { ews: 14, ws: 4.2, mls: 2.6, ms: 1.55 };
const FRAMING_HEAD = { mcu: 5.4, cu: 3.6, bcu: 2.4, ecu: 1.35 };
const LABELS = {
  ews: 'EXTREME WIDE', ws: 'WIDE', mls: 'MEDIUM LONG', ms: 'MEDIUM',
  mcu: 'MEDIUM CLOSE', cu: 'CLOSE-UP', bcu: 'BIG CLOSE-UP', ecu: 'EXTREME CLOSE-UP',
};

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _r = new THREE.Vector3();

export class Cinematographer {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 1.4, 5);
    this.aim = new THREE.Vector3(0, 0.4, 0);
    this.posS = [new Spring(0, 0.5), new Spring(1.4, 0.5), new Spring(5, 0.5)];
    this.aimS = [new Spring(0, 0.45), new Spring(0.4, 0.45), new Spring(0, 0.45)];
    this.lens = 50;
    this.lensS = new Spring(50, 0.5);
    this.dutch = 0;
    this.dutchS = new Spring(0, 0.6);
    this.shot = null;
    this.t = 0;
    this.shakeAmp = 0; this.shakeDecay = 4; this.shakeT = 0;
    this.handheld = 0.5;
    this.focus = 3; this.focusTarget = 3; this.focusRate = 4;
    this.aperture = 1;           // how aggressive the defocus is
    this.whip = 0;               // decaying value the post pass smears with
    this.seed = 0;
    this.label = '';
    this.frozen = false;
    // The walls of the set, in world units.
    this.bounds = { minX: -4.3, maxX: 4.3, minZ: -4.3, maxZ: 3.6, minY: 0.05, maxY: 2.85 };
    // Set dressing the camera must not be buried in; filled in by main.js.
    this.obstacles = [];
  }

  setAspect(a) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  fovFor(lens) { return 2 * Math.atan(SENSOR_H / (2 * lens)) * (180 / Math.PI); }

  // --- shot setup -----------------------------------------------------------

  // Everything is optional; anything omitted is inherited from the last shot,
  // which makes small adjustments cheap to write in the script.
  cut(spec) { return this.take({ ...spec, cut: true }); }
  move(spec) { return this.take({ ...spec, cut: false }); }

  take(spec) {
    const prev = this.shot || {};
    const s = {
      subject: spec.subject ?? prev.subject,
      over: spec.over ?? null,
      frame: spec.frame ?? 'ms',
      lens: spec.lens ?? 50,
      angle: spec.angle ?? 0,          // degrees around the subject; 0 = face on
      strictAngle: spec.strictAngle ?? false,
      height: spec.height ?? 'eye',    // 'eye' | 'low' | 'high' | 'floor' | number
      dutch: spec.dutch ?? 0,
      offset: spec.offset ?? null,     // extra world-space nudge
      aimOffset: spec.aimOffset ?? new THREE.Vector3(0, 0, 0),
      look: spec.look ?? 'head',       // 'head' | 'eye' | 'chest' | 'body' | Vector3
      move: spec.move ?? null,
      view: spec.view ?? null,         // explicit frame height in metres
      dur: spec.dur ?? 6,
      cut: spec.cut ?? false,
      whip: spec.whip ?? false,
      track: spec.track ?? true,
      handheld: spec.handheld ?? 0.5,
      smooth: spec.smooth ?? 0.55,
      focusOn: spec.focusOn ?? null,   // an actor/point to hold focus on
      aperture: spec.aperture ?? 1,
      label: spec.label ?? null,
      t: 0,
      _frozen: null,
    };
    this.shot = s;
    this.handheld = s.handheld;
    this.aperture = s.aperture;
    this.seed += 13.77;

    const smooth = s.cut ? 0.0001 : s.smooth;
    for (const sp of this.posS) sp.smooth = smooth;
    for (const sp of this.aimS) sp.smooth = smooth * 0.9;
    this.lensS.smooth = s.cut ? 0.0001 : Math.max(0.25, smooth);
    this.dutchS.smooth = s.cut ? 0.0001 : 0.9;

    if (s.whip) {
      this.whip = 1;
      for (const sp of this.posS) sp.smooth = 0.075;
      for (const sp of this.aimS) sp.smooth = 0.06;
    }
    this.label = s.label ?? `${LABELS[s.frame] ?? s.frame.toUpperCase()} · ${Math.round(s.lens)}mm`;
    if (s.cut) this.solve(0, true);
    return this;
  }

  shake(power = 1, decay = 3.5) {
    this.shakeAmp = Math.max(this.shakeAmp, power);
    this.shakeDecay = decay;
    return this;
  }

  // Pull focus onto something else without moving the camera. The most
  // under-rated tool in the drawer.
  rackFocus(target, rate = 1.6) {
    this._rack = target;
    this.focusRate = rate;
    return this;
  }

  // --- solve ----------------------------------------------------------------

  anchor(subject, kind, out) {
    if (!subject) return out.set(0, 0.5, 0);
    if (subject.isVector3) return out.copy(subject);
    if (subject.headWorld) {
      if (kind === 'eye') return subject.eyeWorld(out, this.camera.position);
      if (kind === 'chest') return subject.chestWorld(out);
      if (kind === 'body') return subject.bodyWorld(out);
      return subject.headWorld(out);
    }
    if (subject.getWorldPosition) return subject.getWorldPosition(out);
    return out.set(0, 0.5, 0);
  }

  subjectHeight(s) {
    const sub = s.subject;
    if (sub && sub.standHeight !== undefined) return sub.standHeight;
    return 0.5;
  }

  // Roughly the diameter of the skull, which is what a close-up is measured in.
  headSize(s) {
    const sub = s.subject;
    if (sub && sub.size !== undefined) return 0.155 * sub.size;
    return 0.16;
  }

  subjectYaw(s) {
    const sub = s.subject;
    if (!sub) return 0;
    // Tight shots orient off the face; wide shots off the body.
    if (FRAMING_HEAD[s.frame] !== undefined && sub.headYaw) {
      this.rigUpdated(sub);
      return sub.headYaw();
    }
    if (sub.yaw !== undefined) return sub.yaw;
    return 0;
  }

  rigUpdated(sub) {
    // The solve can run before the scene graph is refreshed on a hard cut.
    if (sub.rig) sub.rig.head.updateWorldMatrix(true, false);
  }

  solve(dt, immediate = false) {
    const s = this.shot;
    if (!s) return;
    const u = clamp01(s.t / Math.max(0.001, s.dur));

    // Where the camera is looking.
    const look = s.look instanceof THREE.Vector3 ? _p.copy(s.look) : this.anchor(s.subject, s.look, _p);
    const aim = _q.copy(look).add(s.aimOffset);

    // Framing distance from the lens and the shot size. `view` overrides the
    // subject-relative framing with an explicit frame height in metres, which
    // is how you frame a courtyard rather than a chicken.
    const view = s.view ?? (FRAMING_HEAD[s.frame] !== undefined
      ? this.headSize(s) * FRAMING_HEAD[s.frame]
      : this.subjectHeight(s) * (FRAMING_BODY[s.frame] ?? 1.5));
    let lens = s.lens;
    let dist = (view / 2) / Math.tan((this.fovFor(lens) * Math.PI) / 360);

    // Azimuth: 0 puts the camera in front of the subject's face. The rig faces
    // +Z at yaw 0, so the front of the bird is straight out along its yaw.
    //
    // House rule: a chicken's eyes are on the sides of its head, so a frontal
    // close-up shows two eyes and no beak — the least readable angle there is.
    // Anything tighter than a medium gets nudged onto a three-quarter unless
    // the shot asks for the angle exactly.
    let angle = s.angle;
    if (!s.strictAngle && !s.over && FRAMING_HEAD[s.frame] !== undefined && Math.abs(angle) < 26) {
      angle = (angle < 0 ? -1 : 1) * 38;
    }
    let az = this.subjectYaw(s) + deg(angle);
    let height;
    const eyeY = look.y;
    if (typeof s.height === 'number') height = s.height;
    else if (s.height === 'low') height = Math.min(0.16, eyeY * 0.35);
    else if (s.height === 'floor') height = 0.055;
    else if (s.height === 'high') height = eyeY + 0.85;
    else if (s.height === 'over') height = eyeY + 0.12;
    else height = eyeY;

    // Moves modulate the solve rather than fighting it.
    const m = s.move;
    if (m) {
      const mu = ease[m.ease || 'inOut'](clamp01((s.t - (m.delay || 0)) / (m.dur ?? s.dur)));
      const amt = m.amount ?? 1;
      switch (m.type) {
        case 'push': dist *= lerp(1, 1 - 0.42 * amt, mu); break;
        case 'pull': dist *= lerp(1, 1 + 0.75 * amt, mu); break;
        case 'crane': height += lerp(0, 1.4 * amt, mu); break;
        case 'descend': height += lerp(1.6 * amt, 0, mu); dist *= lerp(1.25, 1, mu); break;
        case 'orbit': az += deg(38 * amt) * (mu - 0.5) * 2; break;
        case 'creep': dist *= lerp(1, 1 - 0.12 * amt, mu); az += deg(7 * amt) * mu; break;
        // Vertigo: the camera pulls back while the lens comes in, so the
        // subject stays the same size and the world folds up behind them.
        case 'dollyZoom': {
          const k = lerp(1, 1 + 1.5 * amt, mu);
          dist *= k;
          lens = lens * k;
          break;
        }
        case 'snapZoom': {
          // Three hard steps in, the way a director punches a reaction.
          const steps = Math.floor(clamp01(mu) * 3.999);
          dist *= 1 - 0.19 * steps * amt;
          break;
        }
        default: break;
      }
    }

    // Over-the-shoulder: sit behind and beside the other actor.
    if (s.over) {
      const o = this.anchor(s.over, 'head', _r);
      const dir = _p.copy(aim).sub(o); dir.y = 0; dir.normalize();
      az = Math.atan2(-dir.x, -dir.z);
      const side = deg(s.angle || 22);
      az += side;
      dist = Math.max(dist, o.distanceTo(aim) * 1.35);
      height = lerp(o.y + 0.1, aim.y, 0.35);
    }

    let px = aim.x + Math.sin(az) * dist;
    let pz = aim.z + Math.cos(az) * dist;

    // Keep the operator inside the courtyard. A wide shot on a subject facing a
    // wall would otherwise park the camera in next door's garden — and simply
    // pulling the camera in toward the subject wrecks the framing (it ends up
    // inside the actor's head). Swing round to the nearest angle that fits and
    // keep the distance, which is what a DP would do on the day.
    const B = this.bounds;
    if (B) {
      // A position is usable if it is inside the walls and not buried in the
      // fountain, the bench or a potted palm.
      const inside = (x, z) => {
        if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) return false;
        for (const o of this.obstacles) {
          if (height < o.top + 0.12 && (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < o.r * o.r) return false;
        }
        return true;
      };
      if (!inside(px, pz)) {
        let found = false;
        for (let k = 1; k <= 15 && !found; k++) {
          for (const dir of [1, -1]) {
            const a = az + dir * k * deg(12);
            const x = aim.x + Math.sin(a) * dist;
            const z = aim.z + Math.cos(a) * dist;
            if (inside(x, z)) { az = a; px = x; pz = z; found = true; break; }
          }
        }
        if (!found) {
          // Nowhere on the circle fits; give up distance, but never get closer
          // than half the framing distance or the shot size collapses.
          const dx = px - aim.x, dz = pz - aim.z;
          let t = 1;
          if (px < B.minX || px > B.maxX) t = Math.min(t, Math.abs(((px < B.minX ? B.minX : B.maxX) - aim.x) / (dx || 1e-6)));
          if (pz < B.minZ || pz > B.maxZ) t = Math.min(t, Math.abs(((pz < B.minZ ? B.minZ : B.maxZ) - aim.z) / (dz || 1e-6)));
          t = clamp(t, 0.5, 1);
          px = aim.x + dx * t;
          pz = aim.z + dz * t;
        }
      }
      height = clamp(height, B.minY, B.maxY);
    }

    if (!s.track && s._frozen) {
      this.pos.copy(s._frozen.pos);
      this.aim.copy(s._frozen.aim);
    } else {
      this.pos.set(px, height, pz);
      this.aim.copy(aim);
      if (s.offset) this.pos.add(s.offset);
      if (!s.track && !s._frozen && s.t > 0) s._frozen = { pos: this.pos.clone(), aim: this.aim.clone() };
    }

    this.lens = lens;
    this.dutch = deg(s.dutch);

    if (immediate) {
      this.posS[0].set(this.pos.x); this.posS[1].set(this.pos.y); this.posS[2].set(this.pos.z);
      this.aimS[0].set(this.aim.x); this.aimS[1].set(this.aim.y); this.aimS[2].set(this.aim.z);
      this.lensS.set(this.lens);
      this.dutchS.set(this.dutch);
      this.focus = this.focusTarget = this.pos.distanceTo(this.aim);
    }
    void u; void dt;
  }

  update(dt, time) {
    if (!this.shot) return;
    this.shot.t += dt;
    this.solve(dt);

    this.posS[0].target = this.pos.x; this.posS[1].target = this.pos.y; this.posS[2].target = this.pos.z;
    this.aimS[0].target = this.aim.x; this.aimS[1].target = this.aim.y; this.aimS[2].target = this.aim.z;
    this.lensS.target = this.lens;
    this.dutchS.target = this.dutch;

    const px = this.posS[0].step(dt), py = this.posS[1].step(dt), pz = this.posS[2].step(dt);
    const ax = this.aimS[0].step(dt), ay = this.aimS[1].step(dt), az = this.aimS[2].step(dt);
    const lens = this.lensS.step(dt);
    const dutch = this.dutchS.step(dt);

    // Operator drift. Even a locked-off shot breathes a little.
    const hh = this.handheld;
    const t = time * 0.6 + this.seed;
    const dx = fbm1(t, 1) * 0.012 * hh;
    const dy = fbm1(t + 3.1, 2) * 0.009 * hh;
    const dz = fbm1(t + 7.7, 3) * 0.01 * hh;

    // Impact shake.
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * this.shakeDecay * this.shakeAmp * 1.4 - dt * 0.02);
    this.shakeT += dt;
    const sh = this.shakeAmp;
    const sx = fbm1(this.shakeT * 26, 11) * 0.055 * sh;
    const sy = fbm1(this.shakeT * 23 + 5, 12) * 0.055 * sh;
    const sr = fbm1(this.shakeT * 19 + 9, 13) * 0.05 * sh;

    const cam = this.camera;
    cam.position.set(px + dx + sx, py + dy + sy, pz + dz);
    cam.up.set(0, 1, 0);
    cam.lookAt(ax, ay + fbm1(t + 11, 4) * 0.006 * hh, az);
    cam.rotateZ(dutch + sr + fbm1(t + 17, 5) * 0.004 * hh);
    const fov = this.fovFor(lens);
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // Focus. Auto-follows the subject unless a rack is in progress.
    const focusOn = this._rack ?? this.shot.focusOn ?? this.shot.subject;
    this.anchor(focusOn, this.shot.look === 'eye' ? 'eye' : 'head', _p);
    this.focusTarget = focusOn instanceof THREE.Vector3
      ? cam.position.distanceTo(focusOn)
      : cam.position.distanceTo(_p);
    this.focus = approach(this.focus, this.focusTarget, this._rack ? this.focusRate : 5.5, dt);
    if (this._rack && Math.abs(this.focus - this.focusTarget) < 0.02) this._rack = null;

    this.whip = Math.max(0, this.whip - dt * 3.4);
    this.lensNow = lens;
  }
}
