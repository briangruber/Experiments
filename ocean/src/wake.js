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

function nearestStamp(pnt, prevs, max = 4) {
  let best = pnt, bestD = max;
  for (const p of prevs) {
    const d = Math.hypot(p[0] - pnt[0], p[1] - pnt[1]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Shared by the water vertex and fragment shaders: both have to agree exactly on
// the shape of the wake, since one displaces the surface by it and the other
// lights it.
export const WAKE_SAMPLE_GLSL = /* glsl */`
uniform sampler2D uWakeTex;
uniform vec2  uWakeOrigin;
uniform vec2  uWakeHead, uWakeFwd;
uniform float uWakeSpeed;
uniform float uWakeExtent, uWakeOn, uWakeLife, uWakeArmW, uWakeArm, uWakeChurn;
uniform float uWakeSpread, uWakeBeam, uWakeDepth, uWakeStrength, uWakeEdge;

// x: foam coverage 0..1   y: surface height, metres (signed)   z: how disturbed
// this water is at all, which is what kills the sea's own ripples inside a track
vec3 wakeAt(vec2 p){
  vec2 uv = (p - uWakeOrigin) / uWakeExtent + 0.5;
  // Inscribed circle, not the square. The square's far edge is a
  // line of constant Z — a dead-straight horizontal cut.
  float radial = length(uv - 0.5) * 2.0;
  if (radial >= 1.0) return vec3(0.0);
  vec4 r = texture(uWakeTex, uv);
  float stir = r.r, age = r.g, lat = r.b, rate = r.a;
  if (stir < 0.002 || age >= uWakeLife) return vec3(0.0);
  float edgeLo = 1.0 - max(uWakeEdge, 0.18) * 1.8;
  float edge = 1.0 - smoothstep(edgeLo, 1.0, radial);
  float fade = max(1.0 - age / uWakeLife, 0.0) * edge;

  float arm = rate * age;
  float w   = max(uWakeArmW * (1.0 + uWakeSpread * age), 0.05);
  float q   = (abs(lat) - arm) / w;
  float ridge = exp(-q * q);
  float cq = lat / max(uWakeBeam * (1.0 + 0.55 * age), 0.15);
  float churnRaw = exp(-cq * cq);
  float churn = churnRaw * max(1.0 - age / (uWakeLife * 0.5), 0.0);

  float born = smoothstep(0.06, 0.22, age);
  // Foam is left on the water the hull touched. Height still rides the
  // travelling Kelvin ridge — that is a surface wave. Painting foam on
  // the ridge made the white scan outward with the arms (a drawn line
  // that the wake carried) instead of staying put and fading.
  float foamW = max(uWakeArmW * (1.0 + 0.28 * age), 0.05);
  float trail = exp(-(lat / foamW) * (lat / foamW));
  float foam = (trail * uWakeArm + churn * uWakeChurn) * stir * fade * born;
  float live = smoothstep(0.0, 0.18, stir);
  float h    = ridge * fade * live * born * uWakeDepth;
  return vec3(clamp(foam * uWakeStrength, 0.0, 1.0), h,
              clamp(churnRaw * stir * fade * born, 0.0, 1.0));
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
    //
    // Strictly at or behind it, never in front. A symmetric window stamped a
    // metre of record ahead of the bow, so the foam ran at full strength up to
    // +1.0 m and hit zero at +1.25 m: a hard edge perpendicular to the heading,
    // travelling with the craft, its exact position set by sub-texel alignment
    // and therefore shimmering. That is the wavy line in front of the craft, and
    // it should never have been there at all - a wake is what is behind you.
    // Ending the record at the craft's own origin puts the discontinuity under
    // the middle of the hull, where the hull covers it.
    //
    // The old boolean window was 1.6 m thick and reach wide — two
    // texels by 144 m, a ruler through an open-water snout. Feather
    // the front and the far-lat ends so the record does not turn on
    // as a wall. Stir ramps with the along window only; far-lat
    // texels keep full stir so the arms can still grow into them.
    // Keep whichever passage came closest. The stamp has to reach out as far as
    // the arms will ever travel, and without this a second lap would reset the
    // clock on a strip 150 m wide and wipe the history it was supposed to be
    // adding to.
    bool empty = rec.r < 0.002;
    bool closer = abs(lat) <= abs(rec.b) + 0.01;
    // Full reach. Age resets only on the front mound. Far-lat is
    // first touch only, then ages so the Kelvin arms leave the
    // track. Resetting a 13 m corridor froze them as two rails.
    float alongW = smoothstep(1.2, -0.4, alo) * smoothstep(-12.0, -6.0, alo);
    float inReach = 1.0 - smoothstep(uReach * 0.88, uReach, abs(lat));
    float nearLat = 1.0 - smoothstep(6.0, 9.0, abs(lat));
    if (alongW > 0.02 && inReach > 0.02) {
      if (nearLat > 0.02 && (empty || closer)) {
        rec = vec4(uStir * alongW, 0.0, lat, uRate);
      } else if (empty) {
        rec = vec4(uStir * alongW, 0.0, lat, uRate);
      }
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
    this.prevStamps = [];
    this.rate = 0;
    this.head = [0, 0];
    this.fwd = [0, 1];
    this.speed = 0;
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
    this.prevStamps = [];
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
    this.prevOrigin[0] = this.origin[0]; this.prevOrigin[1] = this.origin[1];
    const points = wr.active && wr.stampPoints?.length ? wr.stampPoints : null;
    let a = this.prevPos || [this.origin[0], this.origin[1]];
    let b = a;
    if (wr.active) {
      const cxz = wr.surfXZ();
      this.origin[0] = Math.round(cxz[0] / texel) * texel;
      this.origin[1] = Math.round(cxz[1] / texel) * texel;
      if (!points) {
        b = wr.stampB || [cxz[0], cxz[1]];
        a = wr.stampA || this.prevPos || b;
        this.prevPos = b;
        this.prevStamps = [];
      }
    } else {
      this.prevStamps = [];
    }

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

    const fwd = [Math.sin(wr.heading), -Math.cos(wr.heading)];
    const reach = Math.min(this.rate * p.wakeLife * 1.15 + 4, this.extent * 0.45);
    const stepDt = Math.min(dt, 1 / 15);

    if (points) {
      // Age once, then stamp every spray site. Extra passes use dt=0 and an
      // identity reproject so the field is not aged N times or thrown by a
      // moving origin.
      const first = points[0];
      this._flush({ a: nearestStamp(first, this.prevStamps), b: first, fwd, stir, reach, dt: stepDt, life: p.wakeLife, active: true });
      for (let i = 1; i < points.length; i++) {
        this.prevOrigin[0] = this.origin[0];
        this.prevOrigin[1] = this.origin[1];
        const pnt = points[i];
        this._flush({ a: nearestStamp(pnt, this.prevStamps), b: pnt, fwd, stir, reach, dt: 0, life: p.wakeLife, active: true });
      }
      this.prevStamps = points.map((pnt) => [pnt[0], pnt[1]]);
      this.prevPos = first;
    } else {
      this._flush({ a, b, fwd, stir, reach, dt: stepDt, life: p.wakeLife, active: !!wr.active });
    }

    this.prevExtent = this.extent;
    this.fwd = fwd;
    this.head = points && points[0] ? [points[0][0], points[0][1]] : [b[0], b[1]];
    this.speed = wr.active && !wr.airborne ? Math.abs(wr.speed) : 0;
  }

  _flush({ a, b, fwd, stir, reach, dt, life, active }) {
    const gl = this.gl;
    const dst = 1 - this.src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    setUniforms(gl, this.prog, {
      uPrev: this.tex[this.src],
      uOrigin: this.origin, uPrevOrigin: this.prevOrigin,
      uExtent: this.extent, uPrevExtent: this.prevExtent,
      uDt: dt,
      uLife: life,
      uA: new Float32Array(a), uB: new Float32Array(b),
      uFwd: new Float32Array(fwd),
      uRight: new Float32Array([-fwd[1], fwd[0]]),
      uStir: stir, uRate: this.rate,
      uReach: reach,
      uActive: active ? 1 : 0,
    });
    this.blit.draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.src = dst;
  }

  // Everything the water shaders need to reconstruct the pattern.
  uniforms(p, active) {
    return {
      uWakeTex: this.field,
      uWakeOrigin: this.origin,
      uWakeHead: new Float32Array(this.head),
      uWakeFwd: new Float32Array(this.fwd),
      uWakeSpeed: this.speed,
      uWakeExtent: this.extent,
      uWakeOn: active ? 1 : 0,
      uWakeLife: p.wakeLife,
      uWakeArmW: p.wakeWidth,
      uWakeEdge: p.wakeEdgeFade ?? 0.22,
      uWakeArm: p.wakeArm,
      uWakeChurn: p.wakeCentre,
      uWakeSpread: p.wakeSpread,
      uWakeBeam: Math.max(p.wrBeam, 0.3) * 1.6,
      uWakeDepth: p.wakeDepth,
      uWakeStrength: p.wakeStrength,
    };
  }
}
