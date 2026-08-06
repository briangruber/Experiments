// Persistent world-space wake field.
//
// The wake used to be a 28-point polyline in a uniform array. That buffer could
// only remember about six seconds of path, so riding a circle brought you back
// to water that had already forgotten you were ever there - and because the
// polyline only fed the foam mask, the sea's *surface* was never disturbed at
// all.
//
// What is stored here is not the wake but the *record* of the hull passing: as
// the craft goes by, every texel abeam of it writes down how hard the hull was
// working, how far off the track it is, and when that happened. The pattern is
// then reconstructed analytically wherever it is read, which is what makes the
// cusp arms come out right.
//
// The alternative - storing the pattern itself and advecting it outward - was
// tried and does not work at this scale. A Kelvin arm leaves the track at about
// 0.35 of the hull's speed, which at 60 fps is a quarter of a texel per frame,
// and semi-Lagrangian advection at a fraction of a texel per step is almost
// entirely numerical diffusion: the ridge dissolves long before it has travelled
// anywhere. Storing the age instead has no such error, costs one fetch, and the
// history it can hold is bounded only by the buffer's extent.
//
//   .r  how hard the hull was working when it passed  (stir)
//   .g  seconds since it passed                       (age)
//   .b  signed distance from the track, metres        (lat)
//   .a  rate the cusp arms leave that track, m/s

import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';

// Shared by the water vertex and fragment shaders: both have to agree exactly on
// the shape of the wake, since one displaces the surface by it and the other
// lights it.
export const WAKE_SAMPLE_GLSL = /* glsl */`
uniform sampler2D uWakeTex;
uniform vec2  uWakeOrigin;
uniform float uWakeExtent, uWakeOn, uWakeLife, uWakeArmW, uWakeArm, uWakeChurn;
uniform float uWakeSpread, uWakeBeam, uWakeDepth, uWakeStrength;

// x: foam coverage 0..1   y: surface height, metres (signed)   z: how disturbed
// this water is at all, which is what kills the sea's own ripples inside a track
vec3 wakeAt(vec2 p){
  vec2 uv = (p - uWakeOrigin) / uWakeExtent + 0.5;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return vec3(0.0);
  vec4 r = texture(uWakeTex, uv);
  float stir = r.r, age = r.g, lat = r.b, rate = r.a;
  if (stir < 0.002 || age >= uWakeLife) return vec3(0.0);
  // Don't let the wake end on a straight line ruled across the sea where the
  // buffer runs out.
  vec2 ed = min(uv, 1.0 - uv);
  float fade = max(1.0 - age / uWakeLife, 0.0) * smoothstep(0.0, 0.03, min(ed.x, ed.y));

  // The cusp arms stand where they have got to: a ridge at |lat| = rate * age,
  // not a falloff from the centreline. That single fact is the whole difference
  // between a Kelvin wedge and a widening smear down the middle of the path.
  float arm = rate * age;
  float w   = uWakeArmW * (1.0 + uWakeSpread * age);
  float q   = (abs(lat) - arm) / max(w, 0.05);
  float ridge = exp(-q * q);
  // Between them, entrained air: broad, soft, and much shorter lived than the
  // arms, because it is bubbles rather than a surface wave.
  float cq = lat / max(uWakeBeam * (1.0 + 0.55 * age), 0.15);
  float churnRaw = exp(-cq * cq);
  float churn = churnRaw * max(1.0 - age / (uWakeLife * 0.5), 0.0);

  float foam = (ridge * uWakeArm + churn * uWakeChurn) * stir * fade;
  float h    = (ridge * uWakeArm * 0.55 - churn * uWakeChurn * 0.9) * stir * fade * uWakeDepth;
  // The slick is the churned lane between the arms, and only that: it outlives
  // the bubbles that made it, which is why a wake stays legible as a smooth dark
  // path after the white water has gone. Deliberately not including the arms -
  // suppressing the sea's foam along them would take the white off the one part
  // of a wake that is supposed to be white.
  return vec3(clamp(foam * uWakeStrength, 0.0, 1.0), h,
              clamp(churnRaw * stir * fade, 0.0, 1.0));
}
`;

const WAKE_FS = /* glsl */`
uniform sampler2D uPrev;
uniform vec2  uOrigin, uPrevOrigin;
uniform float uExtent, uPrevExtent;
uniform float uDt, uLife;
uniform vec2  uA, uB;             // the hull's path over this frame, world xz
uniform vec2  uFwd, uRight;
uniform float uStir, uRate, uReach, uActive;
in  vec2 vUv;
out vec4 fragColor;

void main(){
  vec2 w = uOrigin + (vUv - 0.5) * uExtent;

  // The buffer was centred somewhere else last frame, so every texel has to be
  // fetched from where its water actually was. The origin is snapped to the
  // texel grid on the CPU, which makes this an exact tap rather than a resample
  // that would soften the whole field a little more every frame.
  vec4 rec = vec4(0.0);
  vec2 pv = (w - uPrevOrigin) / uPrevExtent + 0.5;
  if (pv.x > 0.0 && pv.x < 1.0 && pv.y > 0.0 && pv.y < 1.0) rec = texture(uPrev, pv);

  rec.g += uDt;
  // Clear expired records outright rather than letting them fade: a record is
  // (stir, age, lateral) and interpolating a live one against a stale one would
  // invent a wake that was never laid down.
  if (rec.g >= uLife) rec = vec4(0.0);

  if (uActive > 0.5 && uStir > 0.001) {
    // Measured against the segment the hull swept this frame, not against a
    // point: at 20 m/s a point test would skip whole rows of texels at any frame
    // rate the sim can actually hit.
    vec2 seg = uB - uA;
    float ll = max(dot(seg, seg), 1e-5);
    float t  = clamp(dot(w - uA, seg) / ll, 0.0, 1.0);
    vec2  d  = w - (uA + seg * t);
    float lat = dot(d, uRight);
    float alo = dot(d, uFwd);
    // Abeam of that segment - the projection landed inside it - is the moment
    // this patch of water gets disturbed, and the moment its clock starts.
    bool abeam = abs(alo) < 1.0 && abs(lat) < uReach;
    // Keep whichever passage came closest. The stamp has to reach out as far as
    // the arms will ever travel, and without this a second lap would reset the
    // clock on a strip 150 m wide and wipe the history it was supposed to be
    // adding to.
    bool empty = rec.r < 0.002;
    if (abeam && (empty || abs(lat) <= abs(rec.b) + 0.01)) {
      rec = vec4(uStir, 0.0, lat, uRate);
    }
  }

  fragColor = rec;
}
`;

export class Wake {
  constructor(gl, blit, { size = 512 } = {}) {
    this.gl = gl;
    this.blit = blit;
    this.size = size;
    this.prog = program(gl, FS_VERT, WAKE_FS, 'wake');
    this.tex = [0, 1].map(() => texture2D(gl, {
      width: size, height: size,
      internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    }));
    this.fbo = this.tex.map((t) => framebuffer(gl, [t]));
    this.src = 0;
    this.origin = new Float32Array([0, 0]);
    this.prevOrigin = new Float32Array([0, 0]);
    this.extent = 320;
    this.prevExtent = 320;
    this.prevPos = null;
    this.rate = 0;
    this.clear();
  }

  get field() { return this.tex[this.src]; }

  clear() {
    const gl = this.gl;
    for (const f of this.fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.viewport(0, 0, this.size, this.size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.prevPos = null;
  }

  update(dt, p, wr) {
    const gl = this.gl;
    if (dt <= 0) return;

    this.extent = Math.max(p.wakeExtent, 40);
    // Snapping the centre to the texel grid is what keeps the reprojection above
    // an exact copy: an unsnapped buffer resamples itself every frame and the
    // whole record dissolves into mush in a couple of seconds.
    const texel = this.extent / this.size;
    // Everything here is in the frame the ocean's displacement fields are indexed
    // by, not in world space. The water shaders look this buffer up with the
    // undisplaced grid coordinate, so a record stamped at the craft's *world*
    // position lands a metre or two off the craft and slides around as the waves
    // pass - which is exactly what a wake must not do, since a wake belongs to
    // the water rather than to the sea floor.
    const cxz = wr.surfXZ();
    this.prevOrigin[0] = this.origin[0]; this.prevOrigin[1] = this.origin[1];
    this.origin[0] = Math.round(cxz[0] / texel) * texel;
    this.origin[1] = Math.round(cxz[1] / texel) * texel;

    const a = this.prevPos || [cxz[0], cxz[1]];
    const b = [cxz[0], cxz[1]];
    this.prevPos = b;

    const speedT = Math.min(Math.abs(wr.speed) / Math.max(p.wrTopSpeed * 0.45, 1), 1);
    // Same reading the spray emitter uses: a hard carve is a large load that
    // *sheds* speed, so anything driven off speed alone gets a turn backwards.
    // A hull in the air is not touching the water, so it leaves nothing behind
    // it - which is what makes the gap in the wake read as a jump.
    const stir = wr.airborne ? 0 : Math.min(
      speedT * p.wrWakeSpeed +
      Math.abs(wr.yawRate) * p.wrWakeTurn +
      wr.slip * p.wrWakeSlip +
      (wr.hullLoad ?? 0) * 0.035 +
      wr.impact * 1.2,
      1.4,
    );
    // A Kelvin wedge holds a fixed half-angle, so the arms leave the track at a
    // rate proportional to how fast the hull is laying it down. tan(19.47
    // degrees) is 0.3536; a fixed lateral speed only gets that angle right at
    // exactly one hull speed.
    this.rate = 0.3536 * Math.abs(wr.speed) * p.wakeArmRate;

    const dst = 1 - this.src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    const fwd = [Math.sin(wr.heading), -Math.cos(wr.heading)];
    setUniforms(gl, this.prog, {
      uPrev: this.tex[this.src],
      uOrigin: this.origin, uPrevOrigin: this.prevOrigin,
      uExtent: this.extent, uPrevExtent: this.prevExtent,
      uDt: Math.min(dt, 1 / 15),
      uLife: p.wakeLife,
      uA: new Float32Array(a), uB: new Float32Array(b),
      uFwd: new Float32Array(fwd),
      uRight: new Float32Array([-fwd[1], fwd[0]]),
      uStir: stir, uRate: this.rate,
      // Reach far enough for the arms to have somewhere to go, and no further:
      // every extra metre is a wider swath of records a later lap can overwrite.
      uReach: Math.min(this.rate * p.wakeLife * 1.15 + 4, this.extent * 0.45),
      uActive: wr.active ? 1 : 0,
    });
    this.blit.draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.src = dst;
    this.prevExtent = this.extent;
  }

  // Everything the water shaders need to reconstruct the pattern.
  uniforms(p, active) {
    return {
      uWakeTex: this.field,
      uWakeOrigin: this.origin,
      uWakeExtent: this.extent,
      uWakeOn: active ? 1 : 0,
      uWakeLife: p.wakeLife,
      uWakeArmW: p.wakeWidth,
      uWakeArm: p.wakeArm,
      uWakeChurn: p.wakeCentre,
      uWakeSpread: p.wakeSpread,
      uWakeBeam: Math.max(p.wrBeam, 0.3) * 1.6,
      uWakeDepth: p.wakeDepth,
      uWakeStrength: p.wakeStrength,
    };
  }
}
