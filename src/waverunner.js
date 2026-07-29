// Wave runner: ride the sea instead of flying over it.
//
// The surface only exists on the GPU, so the craft cannot ask "how high is the
// water here?" without a readback - and a synchronous readPixels every frame
// would stall the pipeline behind the whole ocean sim. Instead a 4-texel probe
// pass samples the cascades at the hull's contact points, and the result is
// pulled back through a pixel buffer object guarded by a fence: the CPU reads a
// frame or two late and extrapolates, and the GPU never waits.

import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { clamp, lerp, v3 } from './math.js';

// Probe points, in hull-local metres: centre, bow, port, starboard.
const NPROBE = 4;

const PROBE_FS = /* glsl */`
uniform sampler2DArray uDisp, uFoam;
uniform float uPatch[4];
uniform int   uCascadeCount;
uniform vec2  uProbe[${NPROBE}];
uniform float uHeightScale, uHorizScale, uSeaLevel;
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
    this.vy = 0;
    this.alt = 0;
    this.airborne = false;
    this.bank = 0;
    this.pitchTrim = 0;
    this.rollTrim = 0;
    this.shake = 0;
    this.impact = 0;
    this.probeH = [0, 0, 0, 0];
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
    this.speed = 0; this.vy = 0; this.alt = 0.4;
    this.airborne = false; this.bank = 0; this.shake = 0; this.impact = 0;
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
  probe(p, ocean) {
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
        for (let i = 0; i < NPROBE; i++) this.probeH[i] = this.readBuf[i * 4];
        this.probeFoam = this.readBuf[1];
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

    // ---- throttle and steering ----
    const boost = held('ShiftLeft', 'ShiftRight') ? p.wrBoost : 1;
    const throttle = this.touching ? 1
      : (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    const steer = clamp(
      (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0)
        + this.touchSteer * p.wrTouchSteer,
      -1, 1,
    );

    const top = p.wrTopSpeed * boost;
    if (throttle > 0) this.speed += p.wrAccel * boost * d;
    else if (throttle < 0) this.speed -= p.wrBrake * d;
    // Quadratic drag gives a real terminal speed and a heavy, planing feel.
    this.speed -= this.speed * Math.abs(this.speed) * (p.wrAccel / Math.max(top * top, 1)) * d;
    this.speed = clamp(this.speed, -p.wrTopSpeed * 0.35, top * 1.25);

    // You cannot steer a jet drive with no thrust, and a hull in the air has
    // nothing to bite on. Both are what make it feel like a boat.
    const grip = this.airborne ? p.wrAirSteer : 1;
    const speedT = clamp(Math.abs(this.speed) / Math.max(p.wrTopSpeed * 0.45, 1), 0, 1);
    const turn = steer * p.wrTurnRate * grip * (0.25 + 0.75 * speedT) * Math.sign(this.speed || 1);
    this.heading += turn * d;

    // Bank into the turn, plus a little outward lean from the speed.
    const targetBank = -turn * p.wrBank * (0.4 + 0.6 * speedT);
    this.bank = lerp(this.bank, targetBank, 1 - Math.exp(-6 * d));

    // ---- surface following and flight ----
    const fwd = [Math.sin(this.heading), -Math.cos(this.heading)];
    this.pos[0] += fwd[0] * this.speed * d;
    this.pos[2] += fwd[1] * this.speed * d;

    const hC = this.probeH[0], hF = this.probeH[1], hL = this.probeH[2], hR = this.probeH[3];
    const surf = hC;
    const craftY = surf + this.alt;

    if (this.airborne) {
      this.vy -= p.wrGravity * d;
      this.alt += this.vy * d;
      if (craftY + this.vy * d <= surf + p.wrHover) {
        // Splashdown. Kill the downward velocity, keep some as a jolt.
        this.impact = Math.min(1, Math.abs(this.vy) / 12);
        this.speed *= 1 - p.wrLandingDrag * this.impact;
        this.vy = 0;
        this.alt = p.wrHover;
        this.airborne = false;
      }
    } else {
      // Ride the surface with a spring so the hull does not snap to every ripple.
      const target = p.wrHover;
      const kSpring = p.wrStiffness;
      this.vy += (target - this.alt) * kSpring * d;
      this.vy *= Math.exp(-p.wrDamping * d);
      this.alt += this.vy * d;
      // Launch off a crest: if the water is falling away faster than the hull can
      // follow, it leaves the surface. That is the jump, and it comes free from
      // the wave field rather than from a scripted trigger.
      const dhdt = (surf - (this._lastSurf ?? surf)) / Math.max(d, 1e-3);
      if (dhdt * p.wrLaunch < -p.wrLaunchThreshold && this.speed > p.wrTopSpeed * 0.25) {
        this.airborne = true;
        this.vy = Math.max(this.vy, -dhdt * 0.35 * p.wrLaunch);
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
    this.impact = Math.max(0, this.impact - d * 2.2);
    const chop = this.airborne ? 0 : speedT * (0.35 + 0.65 * clamp(this.probeFoam, 0, 1));
    this.shake = lerp(this.shake, chop, 1 - Math.exp(-8 * d)) + this.impact * 0.7;

    // ---- drive the camera ----
    const t = performance.now() * 0.001;
    const sh = this.shake * p.wrShake * 0.02;
    camera.pos[0] = this.pos[0];
    camera.pos[2] = this.pos[2];
    camera.pos[1] = surf + this.alt + p.wrCamHeight;
    camera.yaw = this.heading + Math.sin(t * 11.0) * sh * 0.6;
    camera.pitch = clamp(
      -this.pitchTrim * p.wrCamPitchFollow + p.wrCamTilt + Math.sin(t * 13.7) * sh,
      -1.2, 1.2,
    );
    camera.roll = (this.bank + this.rollTrim * p.wrCamRollFollow) + Math.sin(t * 9.3) * sh * 0.8;
    // Speed reads on the lens, not just in the numbers.
    camera.fov = p.fov + speedT * p.wrFovKick + this.impact * 4.0;
    camera.moved = true;
  }

  get speedKts() { return this.speed * 1.94384; }
}
