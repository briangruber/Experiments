// Seaplane: taxi on the sea, rotate off it, fly, and put it back down.
//
// The shape of this file is demo/waverunner.js on purpose - same probe
// smoothing, same camera-rig style, same "the physics is plain CPU code fed by
// an async GPU probe" split - because every lesson that file carries (probe
// readings are TARGETS, the camera is DRIVEN while the mode is active, dt is
// clamped) was bought with a reported bug, and a second vehicle re-learning
// them would buy them all again.
//
// The flight model is a path model, not a force integrator: airspeed va along
// a flight path (heading, gamma), with the ATTITUDE (pitch, roll) as what the
// controls actually move and the path following it as fast as the wing has
// authority to make it. That is the honest arcade compromise: it cannot climb
// without speed, it mushes below stall, a bank costs induced drag and buys a
// coordinated turn at g*tan(bank)/v - and it can never explode, because every
// state is a first-order lag toward a bounded target.
//
//   water   throttle spools the prop, hull drag has a displacement hump that
//           planing relieves (the real reason floatplanes "unstick"), rudder
//           authority grows with speed;
//   rotate  above rotation speed, pulling up (or simply exceeding it by 12%)
//           lifts the floats off with the vertical speed the path actually has;
//   fly     bank to turn, pull to climb - IF the wing is fast enough;
//   land    the floats touching the probe's sea is a landing; vertical speed
//           decides how much of it the airframe keeps.

import { clamp, lerp, v3 } from '../src/math.js';

const NPROBE = 4;

export class SeaPlane {

  constructor(opts = {}) {
    this.canvas = opts.canvas || null;
    this.active = false;

    // Hull state.
    this.pos = v3(0, 0, 0);          // CG, world metres; pos[1] is height
    this.heading = 0;
    this.va = 0;                     // airspeed along the path, m/s
    this.gamma = 0;                  // flight path climb angle, rad
    this.pitch = 0;                  // attitude, rad, +nose up
    this.roll = 0;                   // VISUAL roll: negative = right wing down
    this.throttle = 0;               // lever setting, 0..1, persists
    this.airborne = false;
    this.alt = 0;                    // float clearance above the probed surface
    this.vy = 0;                     // water-phase vertical velocity (spring)
    this.yawRate = 0;
    this.steerIn = 0;
    this.pitchIn = 0;
    this.impact = 0;
    this.shake = 0;
    this.slip = 0; this.slipSigned = 0; this.hullLoad = 0;
    this.speed = 0;                  // ground-plane speed, for the wake/spray
    this.speedT = 0;
    this.deckY = 0;

    // Probe plumbing, exactly the wave runner's: readings are TARGETS that the
    // smoothed values chase, because they land every few frames and stepping
    // them straight through is a camera that jumps when one arrives.
    this.probeH = [0, 0, 0, 0];
    this.probeTarget = [0, 0, 0, 0];
    this.probeFoam = 0;
    this.lag = [0, 0]; this.lagTarget = [0, 0];
    this.lagXZ = new Float32Array(2);
    this._primed = false; this._lagPrimed = false;

    // What the wake stamper reads. Refreshed every update; `active` here means
    // "the floats are working the water", so a flying hull stamps nothing.
    this.floatRig = {
      active: false, speed: 0, heading: 0, airborne: false,
      yawRate: 0, slip: 0, hullLoad: 0, impact: 0, speedT: 0,
      surfXZ: () => this.surfXZ(),
    };

    this.touching = false; this.touchSteer = 0; this.touchPitch = 0;
    this._bindTouch();
  }

  // Same one-thumb scheme as the ski, plus a vertical axis: hold is the
  // throttle, slide sideways banks, slide up and down pitches.
  _bindTouch() {
    const c = this.canvas;
    if (!c) return;
    let ox = 0, oy = 0;
    const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
    c.addEventListener('pointerdown', (e) => {
      if (!this.active || !isTouch(e)) return;
      this.touching = true; ox = e.clientX; oy = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this.touching || !isTouch(e)) return;
      const half = Math.max(c.clientWidth, 1) * 0.28;
      this.touchSteer = clamp((e.clientX - ox) / half, -1, 1);
      this.touchPitch = clamp((oy - e.clientY) / (Math.max(c.clientHeight, 1) * 0.22), -1, 1);
    });
    const end = (e) => {
      if (!isTouch(e)) return;
      this.touching = false; this.touchSteer = 0; this.touchPitch = 0;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  reset(camera) {
    this.pos[0] = camera.pos[0]; this.pos[2] = camera.pos[2];
    this.pos[1] = 0;
    this.heading = camera.yaw;
    this.va = 0; this.gamma = 0; this.pitch = 0; this.roll = 0;
    this.throttle = 0; this.airborne = false;
    this.alt = 2.0; this.vy = 0; this.yawRate = 0; this.steerIn = 0;
    this.impact = 0; this.shake = 0; this.speed = 0; this.speedT = 0;
    this._primed = false; this._lagPrimed = false;
    this.camRig = null;
    this._lastSurf = undefined;
  }

  // Where the floats meet the water: ahead/behind and either side of the CG.
  _probePoints(p) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const fx = s, fz = -c, rx = c, rz = s;
    const L = Math.max(p.spLength, 4) * 0.32, W = Math.max(p.spLength, 4) * 0.14;
    const pts = new Float32Array(NPROBE * 2);
    const put = (i, ox, oz) => { pts[i * 2] = this.pos[0] + ox; pts[i * 2 + 1] = this.pos[2] + oz; };
    put(0, 0, 0);
    put(1, fx * L, fz * L);
    put(2, -rx * W, -rz * W);
    put(3, rx * W, rz * W);
    return pts;
  }
  probePoints(p) { return this._probePoints(p); }

  // Identical contract to WaveRunner.acceptProbe - see that method for why the
  // reading is a target and what dx/dz are.
  acceptProbe(rows) {
    if (!rows || rows.length < NPROBE) return;
    for (let i = 0; i < NPROBE; i++) this.probeTarget[i] = rows[i].h;
    if (!this._primed) {
      for (let i = 0; i < NPROBE; i++) this.probeH[i] = this.probeTarget[i];
      this._primed = true;
    }
    this.probeFoam = rows[0].foam;
    this.lagTarget[0] = rows[0].dx; this.lagTarget[1] = rows[0].dz;
    if (!this._lagPrimed) {
      this.lag[0] = this.lagTarget[0]; this.lag[1] = this.lagTarget[1];
      this._lagPrimed = true;
    }
  }

  surfXZ() {
    this.lagXZ[0] = this.pos[0] + this.lag[0];
    this.lagXZ[1] = this.pos[2] + this.lag[1];
    return this.lagXZ;
  }

  update(dt, p, keys, camera) {
    const d = Math.min(dt, 1 / 20);
    const k = keys;
    const held = (...codes) => codes.some((c) => k.has(c));

    const pk = 1 - Math.exp(-p.wrProbeSmooth * d);
    for (let i = 0; i < NPROBE; i++) this.probeH[i] += (this.probeTarget[i] - this.probeH[i]) * pk;
    this.lag[0] += (this.lagTarget[0] - this.lag[0]) * pk;
    this.lag[1] += (this.lagTarget[1] - this.lag[1]) * pk;

    // ---- controls ----
    // The throttle is a LEVER, not a key: a plane holds its power setting. W
    // advances it, S pulls it back; a touch hold walks it to full.
    const lever = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS') ? 1 : 0);
    this.throttle = clamp(this.throttle + (this.touching ? 0.9 : lever * 0.55) * d, 0, 1);

    const steer = clamp(
      (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
        + this.touchSteer * p.wrTouchSteer, -1, 1);
    // Pull to climb. ArrowDown pushes; W is throttle so the arrows carry pitch.
    const pitchIn = clamp(
      (held('KeyI', 'ShiftLeft', 'ShiftRight') ? 1 : 0) - (held('KeyK', 'ArrowDown') ? 1 : 0)
        + this.touchPitch, -1, 1);
    this.steerIn = lerp(this.steerIn, steer, 1 - Math.exp(-p.wrSteerLag * d));
    this.pitchIn = lerp(this.pitchIn, pitchIn, 1 - Math.exp(-p.wrSteerLag * d));

    const surf = this.probeH[0];
    const liftT = (this.va / Math.max(p.spTakeoff, 1)) ** 2;   // 1 at rotation speed
    const g = 9.81;

    if (!this.airborne) {
      // ---- on the water -------------------------------------------------
      // Thrust against a drag with a HUMP: displacement drag grows fast, then
      // planing relieves most of it. This is why the acceleration sags in the
      // middle of the takeoff run and surges as the hull unsticks - the single
      // most floatplane-feeling thing this model does.
      const planeT = clamp(this.va / (p.spTakeoff * 0.55), 0, 1);
      const hump = 1 - 0.62 * planeT * planeT;
      const kDrag = p.spThrust / Math.max(p.spTakeoff * 1.15, 1) ** 2;
      let acc = p.spThrust * this.throttle
              - kDrag * this.va * Math.abs(this.va) * 2.6 * hump
              - 0.05 * this.va;
      this.va = Math.max(0, this.va + acc * d);

      // Water rudder: authority grows with flow over it.
      const bite = 0.25 + 0.75 * clamp(this.va / 8, 0, 1);
      const targetYaw = this.steerIn * p.spWaterTurn * bite;
      this.yawRate = lerp(this.yawRate, targetYaw, 1 - Math.exp(-p.wrYawInertia * d));
      this.heading += this.yawRate * d;

      // Floats ride the sea on the ski's spring. spCgHeight is where the CG
      // sits above the waterline at rest (the mesh keel is ~2.4 m below the
      // CG on this hull); lift taking the weight off floats it slightly
      // higher on the step.
      const target = p.spCgHeight * (1 + 0.10 * clamp(liftT, 0, 1));
      this.vy += (target - this.alt) * p.wrStiffness * 0.6 * d;
      this.vy *= Math.exp(-p.wrDamping * d);
      this.alt += this.vy * d;
      this.pos[1] = surf + this.alt;

      // Attitude on the water: nose-up on the hump, level on the step, plus
      // whatever the swell under the floats says.
      const humpPitch = 0.10 * planeT * (1 - planeT) * 4 * clamp(this.throttle * 2, 0, 1);
      const seaPitch = Math.atan2(this.probeH[1] - this.probeH[0], Math.max(p.spLength * 0.32, 1));
      const rot = clamp(liftT - 0.72, 0, 0.55) * (0.5 + this.pitchIn);
      this.pitch = lerp(this.pitch, humpPitch + seaPitch + rot * 0.35, 1 - Math.exp(-p.wrAttitudeRate * 0.7 * d));
      const seaRoll = Math.atan2(this.probeH[3] - this.probeH[2], Math.max(p.spLength * 0.28, 1));
      this.roll = lerp(this.roll, seaRoll - this.steerIn * 0.06 * clamp(this.va / 10, 0, 1), 1 - Math.exp(-5 * d));

      // ---- rotation -----------------------------------------------------
      // The wing flies when it is fast enough AND asked to (pulling up), or
      // slightly past rotation speed regardless - ground effect will not hold
      // a hull down forever.
      if (liftT >= 1 && (this.pitchIn > 0.15 || liftT >= 1.25)) {
        this.airborne = true;
        this.gamma = 0.05 + 0.10 * clamp(this.pitchIn, 0, 1);
        this.impact = 0;
      }

      this.speed = this.va;
      this.hullLoad = clamp(this.va * 0.12 * this.throttle, 0, 3) + this.impact * 8;
      this.slip = 0; this.slipSigned = 0;

    } else {
      // ---- flying -------------------------------------------------------
      // Attitude first: what the controls move.
      const rollTarget = -this.steerIn * p.spMaxBank;
      this.roll = lerp(this.roll, rollTarget, 1 - Math.exp(-p.spRollRate * d));

      // The wing's authority: how fast the PATH can follow the ATTITUDE. It
      // scales with dynamic pressure and collapses below stall, which is what
      // makes a low-speed pull mush instead of climb.
      const authority = clamp((this.va / Math.max(p.spStall, 1)) ** 2 - 0.55, 0, 1.6);
      const pitchTarget = clamp(this.pitchIn * p.spMaxPitch + 0.03, -p.spMaxPitch, p.spMaxPitch);
      this.pitch = lerp(this.pitch, pitchTarget, 1 - Math.exp(-p.spPitchRate * d));
      let gTarget = this.pitch * clamp(authority, 0, 1);
      if (this.va < p.spStall) {
        // Mush: the nose you hold is not the path you get.
        gTarget = Math.min(gTarget, -0.06) - 0.30 * (1 - this.va / p.spStall);
      }
      this.gamma = lerp(this.gamma, gTarget, 1 - Math.exp(-(0.4 + 2.2 * authority) * d));

      // Coordinated turn out of the bank. roll is the VISUAL sign (negative =
      // right wing down), so the right-hand turn is heading increasing.
      this.yawRate = -g * Math.tan(this.roll) / Math.max(this.va, 8);
      this.heading += this.yawRate * d;

      // Airspeed along the path: thrust, gravity along gamma, parasite drag,
      // and the induced drag a bank buys.
      const kDrag = p.spThrust / Math.max(p.spTopSpeed, 1) ** 2;
      const induced = 1 + 0.5 * Math.tan(this.roll) ** 2
                    + 2.2 * clamp(1 - this.va / Math.max(p.spStall * 1.6, 1), 0, 1);
      this.va += (p.spThrust * this.throttle
                - g * Math.sin(this.gamma)
                - kDrag * this.va * this.va * induced) * d;
      this.va = Math.max(0, this.va);

      // Path integration.
      const cg = Math.cos(this.gamma);
      this.pos[0] += Math.sin(this.heading) * this.va * cg * d;
      this.pos[2] += -Math.cos(this.heading) * this.va * cg * d;
      this.pos[1] += this.va * Math.sin(this.gamma) * d;
      this.alt = this.pos[1] - surf;

      // ---- touchdown ----------------------------------------------------
      if (this.pos[1] <= surf + p.spCgHeight && this.gamma <= 0.02) {
        const sink = Math.max(0, -this.va * Math.sin(this.gamma));
        this.impact = clamp(sink / 4.5 + Math.abs(this.roll) * 0.8, 0.06, 1);
        // A hard arrival scrubs speed; a greased one keeps nearly all of it.
        this.va *= 1 - 0.28 * this.impact;
        this.airborne = false;
        this.gamma = 0; this.vy = 0;
        this.alt = p.spCgHeight;
        this.pos[1] = surf + this.alt;
      }

      this.speed = this.va * cg;
      this.hullLoad = 0; this.slip = 0; this.slipSigned = 0;
    }

    // Shared feel: foam chop through the floats on the water, engine thrum in
    // the air, impacts everywhere.
    this.impact = Math.max(0, this.impact - d * 1.8);
    const chop = this.airborne ? 0.04 * this.throttle
      : clamp(this.va / p.spTakeoff, 0, 1) * (0.3 + 0.7 * clamp(this.probeFoam, 0, 1));
    this.shake = lerp(this.shake, chop, 1 - Math.exp(-8 * d)) + this.impact * 0.8;
    this.speedT = clamp(this.va / Math.max(p.spTakeoff, 1), 0, 1);
    this.deckY = this.pos[1];
    this._lastSurf = surf;

    // The wake stamper's view of this vehicle.
    const fr = this.floatRig;
    fr.active = this.active && !this.airborne;
    fr.speed = this.speed; fr.heading = this.heading; fr.airborne = this.airborne;
    fr.yawRate = this.yawRate; fr.slip = this.slip; fr.hullLoad = this.hullLoad;
    fr.impact = this.impact; fr.speedT = this.speedT;

    // ---- the camera -----------------------------------------------------
    const t = performance.now() * 0.001;
    const sh = this.shake * p.wrShake * 0.02;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const fovT = clamp(this.va / Math.max(p.spTopSpeed, 1), 0, 1.2);

    if (p.wrView >= 0.5) {
      // Chase, in the ski's exact idiom: the rig is pulled toward its ideal
      // spot, climbs as the speed builds, and never sinks into the sea.
      const pull = 1 + fovT * fovT * p.wrCamPull * 0.7;
      const want = [
        this.pos[0] - fx * p.spCamDistance * pull,
        this.pos[1] + p.spCamRise * (1 + 0.6 * fovT),
        this.pos[2] - fz * p.spCamDistance * pull,
      ];
      if (!this.camRig) this.camRig = want.slice();
      const ck = 1 - Math.exp(-p.wrCamLag * d);
      for (let i = 0; i < 3; i++) this.camRig[i] += (want[i] - this.camRig[i]) * ck;
      this.camRig[1] = Math.max(this.camRig[1], surf + p.wrCamMinClear);

      const look = [
        this.pos[0] + fx * p.spCamLook,
        this.pos[1] + this.va * Math.sin(this.gamma) * 0.6,
        this.pos[2] + fz * p.spCamLook,
      ];
      const dx = look[0] - this.camRig[0], dy = look[1] - this.camRig[1], dz = look[2] - this.camRig[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      camera.pos[0] = this.camRig[0]; camera.pos[1] = this.camRig[1]; camera.pos[2] = this.camRig[2];
      camera.yaw = Math.atan2(dx / len, -dz / len) + Math.sin(t * 11.0) * sh * 0.3;
      camera.pitch = clamp(Math.asin(clamp(dy / len, -1, 1)) + Math.sin(t * 13.7) * sh * 0.4, -1.2, 1.2);
      camera.roll = this.roll * 0.5 + Math.sin(t * 9.3) * sh * 0.3;
    } else {
      // On the deck: pilot's eye, attitude and all.
      this.camRig = null;
      camera.pos[0] = this.pos[0] + fx * p.spLength * 0.1;
      camera.pos[1] = this.pos[1] + p.spLength * 0.16;
      camera.pos[2] = this.pos[2] + fz * p.spLength * 0.1;
      camera.yaw = this.heading + Math.sin(t * 11.0) * sh * 0.5;
      camera.pitch = clamp(this.pitch * 0.85 + Math.sin(t * 13.7) * sh * 0.7, -1.2, 1.2);
      camera.roll = this.roll + Math.sin(t * 9.3) * sh * 0.6;
    }

    const wantFov = p.spFovKick * fovT * fovT + this.impact * 3.0;
    this.fovKick = lerp(this.fovKick ?? 0, wantFov, 1 - Math.exp(-p.wrFovLag * d));
    camera.fov = p.fov + this.fovKick;
    camera.moved = true;
  }

  get speedKts() { return this.va * 1.94384; }
  get altitude() { return Math.max(0, this.alt); }
}
