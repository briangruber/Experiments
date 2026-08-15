// The cinematographer. The director asks for a shot in film terms — subject,
// framing, lens, angle, move — and this works out where to put the camera and
// how to get there.

import * as THREE from '../vendor/three/three.module.min.js';
import { clamp, clamp01, lerp, lerpAngle, approach, deg, ease, fbm1, Spring, TAU } from './util.js';

const SENSOR_H = 24; // mm — full-frame vertical, so lens numbers read normally

// Wide shots are framed off the subject's full height; anything from a medium
// close-up in is framed off the head, or a chick gets an unusable macro shot.
//
// These numbers were measured, not guessed: tools/framing-metric.mjs projects
// the live subject through the live camera and reports its standing height as
// a share of the frame. Every shot in the episode came back about twice as
// wide as its own label — a "close-up" was putting the whole bird on screen
// with room to spare, which is what makes coverage read as a webcam rather
// than as photography. Halved, a close-up is now head and shoulders and a
// medium cuts at the chest, the way the words mean.
const FRAMING_BODY = { ews: 5.6, ws: 2.3, mls: 1.45, ms: 0.98 };
const FRAMING_HEAD = { mcu: 2.4, cu: 1.75, bcu: 1.5, ecu: 1.0 };

// Where the subject belongs in the frame, as normalised device coordinates
// (0 is centre, +1 the top or right edge).
//
// COMPOSE_Y is headroom: the eyes ride near the upper third, tighter shots
// higher, because a face centred vertically leaves a dead half-frame of
// forehead above it. COMPOSE_X is looking room — the subject is pushed away
// from the direction they face so they look ACROSS the frame into space
// rather than off the edge of it. Both are applied by tilting and panning the
// lens, never by moving the camera: the operator's feet stay where the shot
// put them, exactly as they would on the day.
// Looking room peaks in the middle sizes and falls off at both ends: a wide
// already has scenery to look into, and on a big close-up the head is most of
// the frame, so leading it hard only jams it into a corner with a dead half
// frame beside it — which on a night set is a black hole, not composition.
const COMPOSE_Y = { ecu: 0.10, bcu: 0.18, cu: 0.23, mcu: 0.25, ms: 0.22, mls: 0.18, ws: 0.12, ews: 0.06 };
const COMPOSE_X = { ecu: 0.05, bcu: 0.10, cu: 0.13, mcu: 0.16, ms: 0.15, mls: 0.11, ws: 0.06, ews: 0.03 };
const LABELS = {
  ews: 'EXTREME WIDE', ws: 'WIDE', mls: 'MEDIUM LONG', ms: 'MEDIUM',
  mcu: 'MEDIUM CLOSE', cu: 'CLOSE-UP', bcu: 'BIG CLOSE-UP', ecu: 'EXTREME CLOSE-UP',
};

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3();

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
    this.focus = 3; this.focusTarget = 3;
    // Rack focus state: a timed S-curve from _rackFrom to wherever the target
    // is by the time the pull lands.
    this._rack = null; this._rackFrom = 3; this._rackT = 0; this._rackDur = 1;
    // The operator's body. Raw noise reads as vibration; what a person's
    // weight does is drift, so the noise is chased through two cascaded
    // low-pass stages per channel (x, y, z, aim, roll) — the second stage has
    // continuous velocity, which is the difference between sway and jitter.
    this._drift = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this._breath = 0;            // breathing-rate sway phase
    // Solver continuity: the framing follows the subject's (head) yaw, and a
    // chicken can flick its head 40 degrees in a frame — the operator cannot.
    this._yawS = null;           // low-passed subject yaw
    this._azS = null;            // last solved azimuth, for rate-limiting
    this._overS = null;          // low-passed over-the-shoulder geometry
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
      // Composition. `false` centres the subject, which a symmetrical frame —
      // a title card, a bow straight down the barrel — actually wants.
      compose: spec.compose ?? true,
      // A subject addressing the lens has no side to look into, so leading it
      // would just shove it off centre for nothing.
      toCamera: spec.toCamera ?? (spec.strictAngle === true && (spec.angle ?? 0) === 0),
      t: 0,
      _frozen: null,
    };
    this.shot = s;
    this.handheld = s.handheld;
    this.aperture = s.aperture;
    this.seed += 13.77;

    // The springs always run at real smoothing. A cut still lands exactly
    // framed — solve(0, true) below snaps them onto the new set-up — but from
    // the second frame on the shot tracks its subject through the filter
    // instead of raw: leaving a cut's springs at ~0 smoothing passed every
    // solver step (a head flick, an avoidance correction) straight to the
    // rendered camera for the life of the shot. On a cut the smoothing is
    // capped low: `smooth` is written by scenes as the TRANSITION feel of a
    // move()-in, and letting a big value drag a cut shot's scripted crane or
    // push seconds behind its ease would re-time the scene. A snap zoom is
    // the one move whose punch lives in the spring: cap its lag so the steps
    // stay steps.
    let smooth = s.cut ? Math.min(s.smooth, 0.5) : s.smooth;
    if (s.move && s.move.type === 'snapZoom') smooth = Math.min(smooth, 0.16);
    for (const sp of this.posS) sp.smooth = smooth;
    for (const sp of this.aimS) sp.smooth = smooth * 0.9;
    this.lensS.smooth = Math.max(0.25, smooth);
    this.dutchS.smooth = 0.9;

    if (s.whip) {
      this.whip = 1;
      // A whip that is not a hard cut really swings there: fast springs are
      // the pan. On a cut the snap below wins and the smear sells it.
      if (!s.cut) {
        for (const sp of this.posS) sp.smooth = 0.075;
        for (const sp of this.aimS) sp.smooth = 0.06;
      }
    }
    // Re-anchor the solver's continuity state on the new shot.
    this._yawS = null;
    this._azS = null;
    this._overS = null;
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
  // under-rated tool in the drawer. `rate` keeps its old sense — bigger is
  // faster — but the pull is a timed S-curve now, not an exponential: it
  // leaves gently, commits, and settles without the long asymptotic tail.
  rackFocus(target, rate = 1.6) {
    this._rack = target;
    this._rackFrom = this.focus;
    this._rackT = 0;
    this._rackDur = clamp(1.9 / Math.max(0.2, rate), 0.35, 4);
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
    // Nobody puts a 135 mm lens three quarters of a metre from their subject.
    // On a bird this small the tightest sizes solve to exactly that, and at
    // that range a centimetre of anchor error is half a frame — Valentina's
    // crash zoom was landing on her comb with her face below the bottom edge.
    // Holding a working minimum costs a little of the size and buys a shot
    // that survives the actor moving.
    dist = Math.max(dist, 1.05);

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
    // The framing follows the subject's yaw — but through an operator, not a
    // servo. A head flick moves the raw yaw 40 degrees in a frame, and orbiting
    // the camera with it teleported the solve target metres at close-up
    // distances. Drift after it instead; a cut re-anchors instantly.
    const rawYaw = this.subjectYaw(s);
    if (immediate || this._yawS === null) this._yawS = rawYaw;
    else this._yawS = lerpAngle(this._yawS, rawYaw, 1 - Math.exp(-3.2 * dt));
    let az = this._yawS + deg(angle);
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
      // Quintic by default: zero velocity AND zero acceleration at both ends,
      // so a move leaves its mark gently and settles instead of stopping.
      const mu = ease[m.ease || 'soft'](clamp01((s.t - (m.delay || 0)) / (m.dur ?? s.dur)));
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
          // Three hard steps in, the way a director punches a reaction. Each
          // step attacks in its first third — that is the punch, protect it —
          // and the shaped ramp plus the (deliberately short) spring give the
          // landing a tail instead of a wall.
          const sN = clamp01(mu) * 3;
          const base = Math.floor(sN);
          const steps = Math.min(3, base + ease.cubicOut(clamp01((sN - base) / 0.34)));
          dist *= 1 - 0.19 * steps * amt;
          break;
        }
        default: break;
      }
    }

    // Over-the-shoulder: sit behind and beside the other actor. Two care
    // points, both learnt from the almost-kiss. The line of the shot comes
    // from the BODIES, not the heads: two heads leaning in close to
    // beak-to-beak, and a direction read off that collapsing baseline turned
    // every head bob into degrees of pan on a 100mm lens. And the derived
    // set-up is chased through the same low-pass the subject yaw gets — an
    // operator holding an OTS keeps their feet planted and lets the
    // foreground shoulder drift in the frame rather than re-framing at
    // gesture rate. A cut (or the shot's first solve) re-anchors instantly.
    if (s.over) {
      const o = this.anchor(s.over, 'head', _r);
      const ob = this.anchor(s.over, 'body', _s);
      const sb = this.anchor(s.subject, 'body', _p);
      const dx = sb.x - ob.x, dz = sb.z - ob.z;
      // With the bodies on top of each other there is no line to sit on;
      // hold the last one rather than divide by noise.
      const oaz = Math.hypot(dx, dz) > 0.05 ? Math.atan2(-dx, -dz) + deg(s.angle || 22) : null;
      const odist = Math.max(dist, o.distanceTo(aim) * 1.35);
      const oheight = lerp(o.y + 0.1, aim.y, 0.35);
      if (immediate || !this._overS) {
        this._overS = { az: oaz ?? az, dist: odist, height: oheight };
      } else {
        const k = 1 - Math.exp(-3.2 * dt);
        const ov = this._overS;
        if (oaz !== null) ov.az = lerpAngle(ov.az, oaz, k);
        ov.dist = lerp(ov.dist, odist, k);
        ov.height = lerp(ov.height, oheight, k);
      }
      az = this._overS.az;
      dist = this._overS.dist;
      height = this._overS.height;
    }

    let px = aim.x + Math.sin(az) * dist;
    let pz = aim.z + Math.cos(az) * dist;

    // Keep the operator inside the courtyard. A wide shot on a subject facing a
    // wall would otherwise park the camera in next door's garden — and simply
    // pulling the camera in toward the subject wrecks the framing (it ends up
    // inside the actor's head). Swing round to the nearest angle that fits and
    // keep the distance, which is what a DP would do on the day.
    const B = this.bounds;
    // A position is usable if it is inside the walls and not buried in the
    // fountain, the bench or a potted palm.
    const inside = (x, z) => {
      if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) return false;
      for (const o of this.obstacles) {
        if (height < o.top + 0.12 && (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < o.r * o.r) return false;
      }
      // Standing somewhere legal is not the same as being able to see. The
      // avoidance search only ever asked whether the camera was buried in the
      // fountain, so a set-up could pass with a palm squarely between the lens
      // and the subject — and the tighter the shot, the likelier that gets, as
      // Valentina's crash zoom found out by playing her best line to a wall.
      // So the line of sight has to clear the same obstacles the body does.
      const sightY = Math.min(height, aim.y);
      for (const o of this.obstacles) {
        if (o.top < sightY - 0.05) continue;          // too short to be in the way
        const dx = aim.x - x, dz = aim.z - z;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        // Nearest approach of the obstacle's centre to the camera-to-subject
        // segment, clamped to the segment itself.
        let t = ((o.x - x) * dx + (o.z - z) * dz) / len2;
        t = clamp(t, 0, 1);
        const nx = x + dx * t - o.x, nz = z + dz * t - o.z;
        // A graze at the very edge of the silhouette is fine — a foreground
        // frond breaking the corner of frame is depth, not an accident.
        if (nx * nx + nz * nz < o.r * o.r * 0.7) return false;
      }
      return true;
    };
    if (B) {
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

    // However the azimuth got here — yaw drift, an orbit, or the avoidance
    // search snapping to a new answer — the solved angle never jumps: it pans
    // at most so fast, and the springs downstream only ever see a target that
    // moves like a camera. The rate is far above any scripted move, so this
    // only bites on discontinuities. If the rate-limited angle would put the
    // camera somewhere unusable, take the search's answer at once — clipping
    // into the set is worse than a hard pan.
    if (!immediate && this._azS !== null && dt > 0) {
      let d = (az - this._azS) % TAU;
      if (d > Math.PI) d -= TAU;
      if (d < -Math.PI) d += TAU;
      const maxStep = deg(150) * dt;
      if (Math.abs(d) > maxStep) {
        const lim = this._azS + Math.sign(d) * maxStep;
        const x = aim.x + Math.sin(lim) * dist;
        const z = aim.z + Math.cos(lim) * dist;
        if (!B || inside(x, z)) { az = lim; px = x; pz = z; }
      }
    }
    this._azS = az;

    // --- composition ---------------------------------------------------------
    // The camera is standing in the right place; this decides where in the
    // frame the subject lands once it gets there. Everything above aims the
    // lens straight at the head, which centres it — the one thing every guide
    // to framing tells you not to do.
    //
    // Offsetting the LOOK target rather than the camera means the geometry the
    // solver just worked out (the shoulder line of an over, the avoidance
    // search's angle, the crane height) survives untouched: the operator holds
    // their mark and reframes with the head, which is also why this cannot
    // push the lens into a wall.
    if (s.compose !== false) {
      const cy = COMPOSE_Y[s.frame] ?? 0.2;
      const cx = COMPOSE_X[s.frame] ?? 0.12;
      _r.set(px, height, pz);
      const toAim = _s.copy(aim).sub(_r);
      const d = toAim.length();
      if (d > 1e-4) {
        toAim.divideScalar(d);
        const frameH = 2 * d * Math.tan((this.fovFor(lens) * Math.PI) / 360);
        const frameW = frameH * (this.camera.aspect || 1.78);
        // Camera basis. Roll is applied downstream, so world up is the
        // right reference here.
        const right = _p.set(0, 1, 0).cross(toAim).normalize().negate();
        const up = new THREE.Vector3().crossVectors(right, toAim);

        // Which way is the subject facing, on screen? A bird turned away from
        // the lens needs room in front of its beak; one looking down the
        // barrel needs none, and the term falls to zero on its own.
        let tx = 0;
        const sub = s.subject;
        if (sub && sub.yaw !== undefined && !s.toCamera) {
          const faceRight = Math.sin(sub.yaw) * right.x + Math.cos(sub.yaw) * right.z;
          tx = -faceRight * cx;
        }
        // An over-the-shoulder already spends one side of the frame on the
        // foreground head; leading the subject as hard as a clean single would
        // crush them against the far edge.
        if (s.over) tx *= 0.5;

        // Compose on the EYES, not on whatever the shot happens to aim at.
        // On a close-up the eye sits far enough above the head anchor to be a
        // quarter of the frame by itself, so composing the anchor and hoping
        // put the eyeline out of the top of the picture.
        const ref = (sub && sub.eyeWorld) ? sub.eyeWorld(_q.clone(), _r) : aim;
        const dy = ref.dot(up) - aim.dot(up);
        const dx = ref.dot(right) - aim.dot(right);
        this.aim.copy(aim)
          .addScaledVector(right, dx - tx * frameW * 0.5)
          .addScaledVector(up, dy - cy * frameH * 0.5);
        aim.copy(this.aim);
      }
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
    void u;
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

    // Operator drift. Even a locked-off shot breathes a little. Two layers:
    // a slow wander (the operator's weight shifting) and a breathing-rate
    // sway. The wander is noise chased through two cascaded low-pass stages,
    // so its velocity is continuous — the seed jump at a cut just gives the
    // drift somewhere new to lean towards, it never pops.
    const hh = this.handheld;
    const t = time * 0.5 + this.seed;
    const D = this._drift;
    const driftCh = (ch, i, rate) => {
      D[i] = approach(D[i], fbm1(t + ch * 3.7, ch), rate, dt);
      D[i + 1] = approach(D[i + 1], D[i], rate, dt);
      return D[i + 1];
    };
    const wx = driftCh(1, 0, 2.4);
    const wy = driftCh(2, 2, 2.4);
    const wz = driftCh(3, 4, 2.4);
    const wa = driftCh(4, 6, 3.0);
    const wr = driftCh(5, 8, 3.0);
    this._breath += dt * TAU * (0.3 + 0.05 * wr);
    const br = Math.sin(this._breath);
    const dx = wx * 0.014 * hh;
    const dy = (wy * 0.008 + br * 0.0035) * hh;
    const dz = wz * 0.012 * hh;

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
    cam.lookAt(ax, ay + (wa * 0.006 + br * 0.002) * hh, az);
    cam.rotateZ(dutch + sr + wr * 0.004 * hh);
    const fov = this.fovFor(lens);
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // Focus. Auto-follows the subject unless a rack is in progress. Distances
    // are measured from the spring pose (px, py, pz), not the rendered
    // position — measuring from a camera that carries handheld sway and shake
    // fed the sway straight into the focal plane, and the DoF breathed.
    const focusOn = this._rack ?? this.shot.focusOn ?? this.shot.subject;
    this.anchor(focusOn, this.shot.look === 'eye' ? 'eye' : 'head', _p);
    _r.set(px, py, pz);
    this.focusTarget = focusOn instanceof THREE.Vector3
      ? _r.distanceTo(focusOn)
      : _r.distanceTo(_p);
    if (this._rack) {
      this._rackT += dt;
      const u = clamp01(this._rackT / this._rackDur);
      this.focus = lerp(this._rackFrom, this.focusTarget, ease.soft(u));
      if (u >= 1) this._rack = null;
    } else {
      this.focus = approach(this.focus, this.focusTarget, 5.5, dt);
    }

    this.whip = Math.max(0, this.whip - dt * 3.4);
    this.lensNow = lens;
  }
}
