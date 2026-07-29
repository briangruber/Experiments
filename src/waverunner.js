// Wave runner: ride the sea instead of flying over it.
//
// The surface only exists on the GPU, so the craft cannot ask "how high is the
// water here?" without a readback - and a synchronous readPixels every frame
// would stall the pipeline behind the whole ocean sim. Instead a 4-texel probe
// pass samples the cascades at the hull's contact points, and the result is
// pulled back through a pixel buffer object guarded by a fence: the CPU reads a
// frame or two late and extrapolates, and the GPU never waits.

import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { WAKE_SAMPLE_GLSL } from './wake.js';
import { clamp, lerp, v3 } from './math.js';

// Probe points, in hull-local metres: centre, bow, port, starboard.
const NPROBE = 4;

const PROBE_FS = /* glsl */`
${WAKE_SAMPLE_GLSL}
uniform sampler2DArray uDisp, uFoam;
uniform float uPatch[4];
uniform int   uCascadeCount;
uniform vec2  uProbe[${NPROBE}];
uniform float uHeightScale, uHorizScale, uSeaLevel;
// The craft's own wake field, so crossing your own path is something you feel
// and not just something you see. wakeAt() is shared with the water shaders.
uniform vec2  uCraftXZ;
uniform float uWakeProbe, uWakeNear;
out vec4 fragColor;

// Displacement is Lagrangian: the texture says where the water at reference
// point x ended up, not what is above world point p. Inverting that is a fixed
// point iteration - x <- p - D_xz(x) - and three passes is well inside a
// centimetre for any choppiness the sim allows.
vec4 surfaceAt(vec2 p){
  vec2 x = p;
  for (int it = 0; it < 3; it++){
    vec2 d = vec2(0.0);
    for (int c = 0; c < 4; c++){
      if (c >= uCascadeCount) break;
      vec4 s = texture(uDisp, vec3(x / uPatch[c], float(c)));
      d += s.xz * uHorizScale;
    }
    x = p - d;
  }
  float h = 0.0, foam = 0.0;
  for (int c = 0; c < 4; c++){
    if (c >= uCascadeCount) break;
    vec3 uvc = vec3(x / uPatch[c], float(c));
    h += texture(uDisp, uvc).y * uHeightScale;
    foam += texture(uFoam, uvc).x;
  }
  // Everything the hull has already done to the sea - but only beyond a few
  // hull lengths. The stamp directly under the craft is the hollow it is making
  // right now, and letting the craft read that back would be a hull sinking
  // into a trough it deepens by sinking. Past the exclusion there is no such
  // loop: that water was disturbed seconds ago and the craft has left it.
  if (uWakeProbe > 0.001) {
    float gate = smoothstep(uWakeNear, uWakeNear * 2.4, distance(x, uCraftXZ));
    if (gate > 0.001) h += wakeAt(x).y * gate * uWakeProbe;
  }
  return vec4(h + uSeaLevel, foam, x - p);
}

void main(){
  int i = int(gl_FragCoord.x);
  fragColor = surfaceAt(uProbe[i]);
}
`;

export class WaveRunner {
  constructor(gl, blit) {
    this.gl = gl;
    this.blit = blit;
    this.active = false;

    this.tex = texture2D(gl, {
      width: NPROBE, height: 1,
      internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
      filter: gl.NEAREST,
    });
    this.fbo = framebuffer(gl, [this.tex]);
    this.prog = program(gl, FS_VERT, PROBE_FS, 'waverunner.probe');

    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, NPROBE * 4 * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.readBuf = new Float32Array(NPROBE * 4);
    this.fence = null;

    // Hull state. Position is on the water plane; `alt` is height above the
    // surface, which is what goes ballistic when the craft leaves a crest.
    this.pos = v3(0, 0, 0);
    this.heading = 0;
    this.speed = 0;
    this.vel = [0, 0];
    this.yawRate = 0;
    this.steerIn = 0;
    this.slip = 0;
    this.vy = 0;
    this.alt = 0;
    this.airborne = false;
    this.bank = 0;
    this.pitchTrim = 0;
    this.rollTrim = 0;
    this.shake = 0;
    this.impact = 0;
    this.probeH = [0, 0, 0, 0];
    this.probeTarget = [0, 0, 0, 0];
    // Where the craft is, expressed in the frame the FFT fields are indexed by.
    this.lag = [0, 0];
    this.lagTarget = [0, 0];
    this.lagXZ = new Float32Array(2);
    this.speedT = 0;
    this.probeFoam = 0;
    this.touchSteer = 0;
    this.touching = false;
    this._bindTouch();
  }

  // A phone has no W key. While riding, holding anywhere on the canvas is the
  // throttle and sliding left or right is the bar, so the whole mode works with
  // one thumb.
  _bindTouch() {
    const c = this.gl.canvas;
    let originX = 0;
    const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
    c.addEventListener('pointerdown', (e) => {
      if (!this.active || !isTouch(e)) return;
      this.touching = true;
      originX = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this.touching || !isTouch(e)) return;
      const half = Math.max(c.clientWidth, 1) * 0.28;
      this.touchSteer = clamp((e.clientX - originX) / half, -1, 1);
    });
    const end = (e) => {
      if (!isTouch(e)) return;
      this.touching = false;
      this.touchSteer = 0;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  reset(camera) {
    this.pos[0] = camera.pos[0];
    this.pos[2] = camera.pos[2];
    this.heading = camera.yaw;
    this.speed = 0; this.vel[0] = 0; this.vel[1] = 0;
    this.yawRate = 0; this.steerIn = 0; this.slip = 0;
    this.vy = 0; this.alt = 0.4;
    this.airborne = false; this.bank = 0; this.shake = 0; this.impact = 0;
    this.airTime = 0; this.worldY = 0;
    this.surfVel = 0; this.surfAcc = 0;
    this.lag[0] = 0; this.lag[1] = 0; this._lagPrimed = false;
    this._lastSurf = undefined;
  }

  // Local offsets of the four probes, rotated into world space.
  _probePoints(p) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    // Heading matches the camera convention: forward is (sin, -cos) in XZ.
    const fx = s, fz = -c, rx = c, rz = s;
    const L = Math.max(p.wrLength, 0.5), Wd = Math.max(p.wrBeam, 0.3);
    const pts = new Float32Array(NPROBE * 2);
    const put = (i, ox, oz) => { pts[i * 2] = this.pos[0] + ox; pts[i * 2 + 1] = this.pos[2] + oz; };
    put(0, 0, 0);
    put(1, fx * L, fz * L);
    put(2, -rx * Wd, -rz * Wd);
    put(3, rx * Wd, rz * Wd);
    return pts;
  }

  // Probe pass + non-blocking fetch of whatever the GPU has finished.
  probe(p, ocean, wake) {
    const gl = this.gl;
    const pts = this._probePoints(p);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, NPROBE, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    setUniforms(gl, this.prog, {
      uDisp: ocean.disp, uFoam: ocean.foamTex,
      uPatch: ocean.patchSizes,
      uCascadeCount: new Int32Array([ocean.cascadeCount]),
      uProbe: pts,
      uHeightScale: p.heightScale, uHorizScale: p.horizScale, uSeaLevel: p.seaLevel,
      ...wake.uniforms(p, this.active),
      uCraftXZ: this.surfXZ(),
      uWakeProbe: p.wakeProbe,
      uWakeNear: Math.max(p.wrLength, 0.5) * 2.5,
    });
    this.blit.draw();

    // Collect the previous request if the GPU has caught up, then queue a new
    // one. clientWaitSync with a zero timeout never blocks.
    if (this.fence) {
      const st = gl.clientWaitSync(this.fence, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(this.fence);
        this.fence = null;
        // Latest reading becomes a target, not the value: the readback lands
        // every few frames and assigning it straight through made the camera
        // jump each time one arrived.
        for (let i = 0; i < NPROBE; i++) this.probeTarget[i] = this.readBuf[i * 4];
        if (!this._primed) { for (let i = 0; i < NPROBE; i++) this.probeH[i] = this.probeTarget[i]; this._primed = true; }
        this.probeFoam = this.readBuf[1];
        // The probe also returns x - p: how far the Lagrangian coordinate the
        // water shaders index by is from the world point the craft is actually
        // at. On the default sea that is 1.3 to 1.7 m, and it swings with the
        // wave phase - so anything the craft writes into a field indexed that
        // way has to be written at x, not at p.
        this.lagTarget[0] = this.readBuf[2];
        this.lagTarget[1] = this.readBuf[3];
        if (!this._lagPrimed) { this.lag[0] = this.lagTarget[0]; this.lag[1] = this.lagTarget[1]; this._lagPrimed = true; }
      }
    }
    if (!this.fence) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, NPROBE, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  update(dt, p, keys, camera) {
    const d = Math.min(dt, 1 / 20);
    const k = keys;
    const held = (...codes) => codes.some((c) => k.has(c));

    // Track the probe continuously toward whatever the GPU last reported.
    const pk = 1 - Math.exp(-p.wrProbeSmooth * d);
    for (let i = 0; i < NPROBE; i++) this.probeH[i] += (this.probeTarget[i] - this.probeH[i]) * pk;
    this.lag[0] += (this.lagTarget[0] - this.lag[0]) * pk;
    this.lag[1] += (this.lagTarget[1] - this.lag[1]) * pk;

    // ---- throttle and steering ----
    const carve = held('ShiftLeft', 'ShiftRight');
    const boost = held('Space') ? p.wrBoost : 1;
    const throttle = this.touching ? 1
      : (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    const steer = clamp(
      (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
        + this.touchSteer * p.wrTouchSteer,
      -1, 1,
    );

    const top = p.wrTopSpeed * boost;

    // A hull carries momentum that does not instantly point where the bars do.
    // Three separate lags stand between the key and the path, and leaving any of
    // them out is what makes a boat handle like a cursor: the bars take time to
    // move, the hull takes time to start rotating, and the velocity keeps its
    // old direction until the hull's grip drags it round.
    this.steerIn = lerp(this.steerIn, steer, 1 - Math.exp(-p.wrSteerLag * d));

    const fwd = [Math.sin(this.heading), -Math.cos(this.heading)];
    const along = this.vel[0] * fwd[0] + this.vel[1] * fwd[1];
    this.speed = along;
    const speedT = clamp(Math.abs(along) / Math.max(p.wrTopSpeed * 0.45, 1), 0, 1);

    // A jet drive steers by vectoring its own thrust: off the throttle there is
    // very little steering, and in the air there is none at all.
    const bite = (this.airborne ? p.wrAirSteer : 1) *
                 (throttle > 0 ? 1 : p.wrCoastSteer);
    // Leaning hard into a turn buys rotation and pays for it in grip and speed,
    // which is what a carve actually is.
    const carveGain = carve ? p.wrCarveTurn : 1.0;
    const targetYaw = this.steerIn * p.wrTurnRate * bite * carveGain *
                      (0.2 + 0.8 * speedT) * Math.sign(along || 1);
    this.yawRate = lerp(this.yawRate, targetYaw, 1 - Math.exp(-p.wrYawInertia * d));
    this.heading += this.yawRate * d;

    // Thrust and drag act along the hull; quadratic drag sets a real top speed.
    let acc = 0;
    if (throttle > 0) acc = p.wrAccel * boost;
    else if (throttle < 0) acc = -p.wrBrake;
    let u = along + acc * d;
    u -= u * Math.abs(u) * (p.wrAccel / Math.max(top * top, 1)) * d;
    // Hard turns scrub speed, which is what stops a full-lock circle being free.
    u *= Math.exp(-Math.abs(this.yawRate) * p.wrTurnDrag * (carve ? p.wrCarveDrag : 1.0) * d);
    u = clamp(u, -p.wrTopSpeed * 0.35, top * 1.25);

    // Sideslip: whatever the velocity has that the hull is not pointing along.
    // Grip bleeds it away over time rather than instantly, so the craft carves
    // and drifts wide out of a hard turn instead of pivoting on the spot.
    const nf = [Math.sin(this.heading), -Math.cos(this.heading)];
    let latX = this.vel[0] - nf[0] * along;
    let latZ = this.vel[1] - nf[1] * along;
    const gripDecay = Math.exp(-(this.airborne ? p.wrAirGrip : p.wrGrip *
                       (carve ? p.wrCarveGrip : 1.0)) * d);
    latX *= gripDecay; latZ *= gripDecay;
    this.vel[0] = nf[0] * u + latX;
    this.vel[1] = nf[1] * u + latZ;
    this.slip = Math.hypot(latX, latZ);
    // Which way it is sliding, not just how fast. The spray emitter needs the
    // sign: a hull shovelling water with its port flank throws that water to
    // port, and a magnitude cannot say which flank.
    this.slipSigned = -latX * nf[1] + latZ * nf[0];   // dot(lateral, right)
    this.throttle = Math.max(throttle, 0);

    // How hard the hull is actually working the water, in m/s^2. Spray is thrown
    // by force, not by speed: a hard carve is a large lateral acceleration and a
    // large sideslip, and it *sheds* speed doing it. Driving emission off speed
    // alone therefore made a hard turn produce LESS spray than a straight run -
    // the turn scrubbed the very quantity the emitter was reading.
    const lateral = Math.abs(u * this.yawRate);       // centripetal
    const decel = Math.max(0, ((this._lastU ?? u) - u) / Math.max(d, 1e-3));
    this._lastU = u;
    this.hullLoad = lateral + this.slip * 3.0 + decel * 0.5 + this.impact * 14.0;

    // Bank follows the actual rotation rate, not the key, so the lean arrives
    // with the turn and unwinds with it.
    const targetBank = -this.yawRate * p.wrBank * (0.4 + 0.6 * speedT);
    this.bank = lerp(this.bank, targetBank, 1 - Math.exp(-5 * d));

    // ---- surface following and flight ----
    this.pos[0] += this.vel[0] * d;
    this.pos[2] += this.vel[1] * d;

    const hC = this.probeH[0], hF = this.probeH[1], hL = this.probeH[2], hR = this.probeH[3];
    const surf = hC;
    const craftY = surf + this.alt;

    // How the water under the hull is moving, and how hard it is accelerating.
    // Riding up a face at speed v over a slope s means the surface under the hull
    // rises at v*s, so this vertical velocity already *is* the ramp: no separate
    // slope term is needed. Two stages of filtering, because a second difference
    // of a probe that is itself smoothed is otherwise mostly noise.
    const dhdtRaw = (surf - (this._lastSurf ?? surf)) / Math.max(d, 1e-3);
    const kf = 1 - Math.exp(-p.wrSurfFilter * d);
    const prevVel = this.surfVel ?? dhdtRaw;
    this.surfVel = prevVel + (dhdtRaw - prevVel) * kf;
    const accRaw = (this.surfVel - prevVel) / Math.max(d, 1e-3);
    this.surfAcc = (this.surfAcc ?? 0) + (accRaw - (this.surfAcc ?? 0)) * kf;
    const dhdt = dhdtRaw;

    if (this.airborne) {
      this.vy -= p.wrGravity * d;
      // In the air the hull follows a parabola in *world* space. Integrating its
      // height above the surface instead made it ride the swell while airborne -
      // so a long jump tracked the wave underneath it rather than flying over it,
      // and a landing could never happen on the back of the wave it left.
      this.worldY += this.vy * d;
      this.alt = this.worldY - surf;
      if (this.vy < 0.0 && this.worldY <= surf + p.wrHover) {
        // Splashdown. Kill the downward velocity, keep some as a jolt.
        this.impact = Math.min(1, Math.abs(this.vy) / 12);
        const keep = 1 - p.wrLandingDrag * this.impact;
        this.vel[0] *= keep; this.vel[1] *= keep;
        this.vy = 0;
        this.alt = p.wrHover;
        this.airborne = false;
        this.airTime = 0;
      } else {
        this.airTime = (this.airTime ?? 0) + d;
      }
    } else {
      // Ride the surface with a spring so the hull does not snap to every ripple.
      const target = p.wrHover;
      const kSpring = p.wrStiffness;
      this.vy += (target - this.alt) * kSpring * d;
      this.vy *= Math.exp(-p.wrDamping * d);
      this.alt += this.vy * d;

      // A hull can only stay on the water while the water's own downward
      // acceleration is gentler than gravity. Past that, the surface is dropping
      // away faster than gravity can pull the hull after it and the two separate -
      // which is exactly what launching off a wave is, and it needs no threshold
      // invented for the purpose.
      //
      // The point of writing it this way is that speed enters squared: the
      // vertical acceleration a hull feels crossing a wave of amplitude A and
      // wavenumber k at speed v is A*k^2*v^2, so doubling the speed quadruples it.
      // That is why charging a swell throws you clear and idling over the same
      // swell does not, and it comes out of the criterion rather than being
      // tuned in.
      const fast = Math.abs(this.speed) > Math.max(p.wrJumpSpeed, 0.1);
      const separates = this.surfAcc < -p.wrGravity * p.wrLaunchG;
      // The short steep chop is the other case: the water simply fell away faster
      // than the suspension could follow it.
      const dropped = dhdt * p.wrLaunch < -p.wrLaunchThreshold;
      if (fast && (separates || dropped)) {
        this.airborne = true;
        // It leaves with the vertical velocity it actually had. Halfway up a face
        // that is most of v*slope and the jump is real; right at the crest it is
        // nearly nothing and the hull just gets light as the water runs out from
        // under it. Both are things that happen.
        this.vy = Math.max(this.vy,
                           this.surfVel * p.wrJumpGain,
                           -dhdt * 0.35 * p.wrLaunch);
        this.worldY = surf + this.alt;
        this.airTime = 0;
      }
    }
    this._lastSurf = surf;

    // Hull attitude from the probe spread: bow-vs-centre is pitch, port-vs-
    // starboard is roll. In the air it relaxes toward level.
    const L = Math.max(p.wrLength, 0.5), Wd = Math.max(p.wrBeam, 0.3);
    const tgtPitch = this.airborne ? clamp(this.vy * 0.03, -0.35, 0.45) : Math.atan2(hF - hC, L);
    const tgtRoll = this.airborne ? 0 : Math.atan2(hR - hL, 2 * Wd);
    const rate = 1 - Math.exp(-p.wrAttitudeRate * d);
    this.pitchTrim = lerp(this.pitchTrim, tgtPitch, rate);
    this.rollTrim = lerp(this.rollTrim, tgtRoll, rate);

    // ---- ride feel ----
    this.carving = carve;
    this.impact = Math.max(0, this.impact - d * 2.2);
    const chop = this.airborne ? 0 : speedT * (0.35 + 0.65 * clamp(this.probeFoam, 0, 1));
    this.shake = lerp(this.shake, chop, 1 - Math.exp(-8 * d)) + this.impact * 0.7;

    // The wake itself is stamped into a world-space field by wake.js, which
    // reads speedT off the craft rather than being handed a list of points.
    this.speedT = speedT;

    // Where the hull itself sits, which third person needs and the deck the
    // rider sits on is measured from.
    this.deckY = surf + this.alt;

    // ---- drive the camera ----
    const t = performance.now() * 0.001;
    const sh = this.shake * p.wrShake * 0.02;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);

    // How fast it is going as a fraction of what it can do. Drives both the
    // framing and the lens, so it has to be known before either.
    const fovT = clamp(Math.abs(this.speed) / Math.max(p.wrTopSpeed, 1), 0, 1.2);

    if (p.wrView >= 0.5) {
      // Chase. The rig trails the craft in world space and is pulled toward its
      // ideal spot rather than pinned to it, so hard turns swing the camera wide
      // and the craft leads the frame - which is what reads as speed.
      // The rig falls back as the craft accelerates away from it, and climbs as it
      // goes, so at speed it is looking down over the plume rather than straight
      // through it. That change of framing is most of what reads as speed in a
      // chase shot - more than the field of view does - and getting above the
      // spray is the only way to keep the craft visible at full throttle.
      const pull = 1 + fovT * fovT * p.wrCamPull;
      const want = [
        this.pos[0] - fx * p.wrCamDistance * pull,
        this.deckY + p.wrCamRise * (1 + p.wrCamLift * fovT * fovT),
        this.pos[2] - fz * p.wrCamDistance * pull,
      ];
      if (!this.camRig) this.camRig = want.slice();
      const k = 1 - Math.exp(-p.wrCamLag * d);
      for (let i = 0; i < 3; i++) this.camRig[i] += (want[i] - this.camRig[i]) * k;
      // Never let the rig sink into the sea it is flying over.
      this.camRig[1] = Math.max(this.camRig[1], surf + p.wrCamMinClear);

      const look = [
        this.pos[0] + fx * p.wrCamLook,
        this.deckY + p.wrCamLookRise,
        this.pos[2] + fz * p.wrCamLook,
      ];
      const dx = look[0] - this.camRig[0], dy = look[1] - this.camRig[1], dz = look[2] - this.camRig[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      camera.pos[0] = this.camRig[0]; camera.pos[1] = this.camRig[1]; camera.pos[2] = this.camRig[2];
      camera.yaw = Math.atan2(dx / len, -dz / len) + Math.sin(t * 11.0) * sh * 0.35;
      camera.pitch = clamp(Math.asin(clamp(dy / len, -1, 1)) + Math.sin(t * 13.7) * sh * 0.5, -1.2, 1.2);
      camera.roll = this.bank * p.wrCamChaseRoll + Math.sin(t * 9.3) * sh * 0.4;
    } else {
      this.camRig = null;
      camera.pos[0] = this.pos[0];
      camera.pos[2] = this.pos[2];
      camera.pos[1] = this.deckY + p.wrCamHeight;
      camera.yaw = this.heading + Math.sin(t * 11.0) * sh * 0.6;
      camera.pitch = clamp(
        -this.pitchTrim * p.wrCamPitchFollow + p.wrCamTilt + Math.sin(t * 13.7) * sh,
        -1.2, 1.2,
      );
      camera.roll = (this.bank + this.rollTrim * p.wrCamRollFollow) + Math.sin(t * 9.3) * sh * 0.8;
    }
    // Speed reads on the lens, not just in the numbers. speedT saturates at 45%
    // of top speed - it exists to fade the handling terms in - so driving the
    // lens off it meant the field of view was already pegged by the time you were
    // half way up the range and the last two thirds of the throttle did nothing
    // to the picture. This tracks the whole range, squared so the first few knots
    // leave the framing alone and the top end opens up hard, and it is lagged so
    // the lens breathes into it instead of snapping.
    const want = p.wrFovKick * fovT * fovT
               + (boost > 1 ? p.wrBoostFov : 0)
               + this.impact * 4.0;
    this.fovKick = lerp(this.fovKick ?? 0, want, 1 - Math.exp(-p.wrFovLag * d));
    camera.fov = p.fov + this.fovKick;
    camera.moved = true;
  }

  // The craft's position in the frame the ocean's own fields live in. Everything
  // the craft writes into those fields - the hull footprint, the wake record -
  // has to be placed here rather than at pos, or it sits a metre or two away from
  // the craft and slides about as the waves go under it.
  surfXZ() {
    this.lagXZ[0] = this.pos[0] + this.lag[0];
    this.lagXZ[1] = this.pos[2] + this.lag[1];
    return this.lagXZ;
  }

  get speedKts() { return this.speed * 1.94384; }
}
