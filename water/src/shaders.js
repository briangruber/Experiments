// All GLSL for the volumetric fluid tank.
//
// three.js compiles ShaderMaterial sources as GLSL ES 3.00 (WebGL2), aliasing
// texture2D→texture and gl_FragColor→out variable, so texelFetch and integer
// ops are available everywhere. The raymarch pass sets glslVersion:GLSL3 and
// declares its own MRT outputs.
//
// The 3D grid (N³ voxels) lives in a 2D atlas: N slices of N×N texels laid
// out in a T×R grid of tiles (T = ceil(sqrt(N))). All neighbour access is
// exact texelFetch; free-position sampling is manual trilinear built from two
// hardware bilinear taps clamped inside their tiles.

export const FS_TRI_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- volume ---

export const VOL_COMMON = /* glsl */ `
uniform int uNi;      // voxels per side
uniform float uNf;
uniform int uTi;      // tiles per atlas row
uniform vec2 uAtlas;  // atlas size in texels

vec4 fetchVox(sampler2D tex, ivec3 v) {
  v = clamp(v, ivec3(0), ivec3(uNi - 1));
  ivec2 t = ivec2(v.z % uTi, v.z / uTi) * uNi + v.xy;
  return texelFetch(tex, t, 0);
}

vec2 tileOrigin(float z) {
  float ti = float(uTi);
  return vec2(mod(z, ti), floor(z / ti)) * uNf;
}

// p in continuous voxel coords, [0..N]^3
vec4 sampleVol(sampler2D tex, vec3 p) {
  p = clamp(p, vec3(0.5), vec3(uNf - 0.5));
  float zf = p.z - 0.5;
  float z0 = floor(zf);
  float f = zf - z0;
  float z1 = min(z0 + 1.0, uNf - 1.0);
  vec4 a = texture2D(tex, (tileOrigin(z0) + p.xy) / uAtlas);
  vec4 b = texture2D(tex, (tileOrigin(z1) + p.xy) / uAtlas);
  return mix(a, b, f);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float sdBox(vec3 p, vec3 b) {
  vec3 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}`;

// gl_FragCoord is fragment-only, so this lives outside VOL_COMMON (which is
// also included in vertex shaders).
export const VOL_FRAG = VOL_COMMON + /* glsl */ `
ivec3 voxelFromFrag() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int x = t.x % uNi, tx = t.x / uNi;
  int y = t.y % uNi, ty = t.y / uNi;
  return ivec3(x, y, ty * uTi + tx);
}`;

// ------------------------------------------------------------- sim passes ---

// Semi-Lagrangian advection (RK2 midpoint). Velocity is stored in voxels/s.
export const ADVECT_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uSrc;
uniform float uDt;
uniform float uDissipation;
uniform float uRise;   // bubble slip through the water, voxels/s (0 for velocity)
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 p = vec3(v) + 0.5;
  vec3 rise = vec3(0.0, uRise, 0.0);
  vec3 vel = fetchVox(uVel, v).xyz + rise;
  vec3 mid = p - 0.5 * uDt * vel;
  vec3 q = p - uDt * (sampleVol(uVel, mid).xyz + rise);
  gl_FragColor = sampleVol(uSrc, q) * uDissipation;
}`;

// MacCormack advection for the foam field: forward semi-Lagrangian step that
// also records the source-neighbourhood extrema at the backtraced point
// (rgb = value, min, max), for the limiter in the combine pass.
export const MM_ADVECT_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uSrc;
uniform float uDt;
uniform float uRise;   // bubbles rise through the fluid rather than with it
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 p = vec3(v) + 0.5;
  vec3 rise = vec3(0.0, uRise, 0.0);
  vec3 vel = fetchVox(uVel, v).xyz + rise;
  vec3 mid = p - 0.5 * uDt * vel;
  vec3 q = p - uDt * (sampleVol(uVel, mid).xyz + rise);
  float val = sampleVol(uSrc, q).x;
  vec3 qf = clamp(q, vec3(0.5), vec3(uNf - 0.5)) - 0.5;
  ivec3 q0 = ivec3(qf);
  float mn = 1e9, mx = -1e9;
  for (int i = 0; i < 8; i++) {
    float s = fetchVox(uSrc, q0 + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1)).x;
    mn = min(mn, s);
    mx = max(mx, s);
  }
  gl_FragColor = vec4(val, mn, mx, 0.0);
}`;

// phi = phi1 + (phi0 - phi2)/2, clamped to the recorded extrema so the
// anti-diffusion correction can't ring or go negative.
export const MM_COMBINE_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uPhi0;
uniform sampler2D uPhi1;
uniform sampler2D uPhi2;
uniform float uDissipation;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec4 f1 = fetchVox(uPhi1, v);
  float phi0 = fetchVox(uPhi0, v).x;
  float phi2 = fetchVox(uPhi2, v).x;
  float val = clamp(f1.x + 0.5 * (phi0 - phi2), f1.y, f1.z);
  gl_FragColor = vec4(max(val, 0.0) * uDissipation, 0.0, 0.0, 0.0);
}`;

// Buoyancy + paddle drag force + click burst impulse + speed clamp.
export const FORCES_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uFoam;
uniform float uDt;
uniform float uBuoyancy;   // voxels/s^2 per unit foam
uniform float uMaxVel;     // voxels/s
uniform float uPaddleOn;
uniform vec3 uPaddlePos;    // world [-1,1]
uniform vec3 uPaddleVel;    // voxels/s
uniform vec3 uPaddleAngVel; // rad/s, world axes
uniform vec3 uPaddleHalf;   // world half extents
uniform mat3 uPaddleRot;    // world -> paddle local
uniform int uBarrelCount;
uniform vec4 uBarrels[6];     // xyz = world position, w = radius
uniform vec4 uBarrelVels[6];  // xyz = world velocity
uniform vec3 uBurstPos;
uniform float uSurfaceY;
uniform float uBurstAmt;   // voxels/s radial impulse (negative = implosion)
uniform float uBurstUp;    // voxels/s vertical kick
uniform float uBurstR;     // world-space radius
uniform float uBurstRing;  // vortex-ring circulation, voxels/s
uniform float uBurstRingR; // ring radius, world
uniform vec3 uEmitPos;     // bubble diffuser, world
uniform float uEmitR;      // world radius of the mouth
uniform float uEmitJet;    // upward push at the mouth, voxels/s^2
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 vel = fetchVox(uVel, v).xyz;
  float foam = fetchVox(uFoam, v).x;
  vec3 wp = (vec3(v) + 0.5) / uNf * 2.0 - 1.0;

  // buoyancy fades out as bubbles near the surface, so plumes decelerate and
  // spread sideways instead of slamming into a lid
  float lift = 1.0 - smoothstep(uSurfaceY - 0.07, uSurfaceY, wp.y);
  vel.y += uBuoyancy * clamp(foam, 0.0, 2.5) * lift * uDt;

  // The diffuser's own updraught. Buoyancy on the foam does most of the work;
  // this is the momentum the bubbles carry off the nozzle, which is what gives
  // the plume a stem before it starts to billow.
  if (uEmitJet > 0.0) {
    vec3 dpe = (wp - uEmitPos) / max(uEmitR, 1e-3);
    vel.y += uEmitJet * exp(-dot(dpe, dpe)) * uDt;
  }

  if (uPaddleOn > 0.5) {
    float d = sdBox(uPaddleRot * (wp - uPaddlePos), uPaddleHalf);
    float w = 1.0 - smoothstep(0.0, 0.18, d);
    // rigid-body velocity of the paddle at this voxel: translation + omega x r
    vec3 target = uPaddleVel + cross(uPaddleAngVel, wp - uPaddlePos) * (uNf * 0.5);
    vel += (target - vel) * (w * min(uDt * 16.0, 1.0));
  }

  // barrels push water as spheres: several can be in flight at once, and at
  // this size the box-vs-sphere difference is invisible in the flow
  for (int i = 0; i < 6; i++) {
    if (i >= uBarrelCount) break;
    float d = length(wp - uBarrels[i].xyz) - uBarrels[i].w;
    float w = 1.0 - smoothstep(0.0, 0.12, d);
    vec3 target = uBarrelVels[i].xyz * (uNf * 0.5);
    vel += (target - vel) * (w * min(uDt * 16.0, 1.0));
  }

  if (uBurstAmt != 0.0 || uBurstUp != 0.0) {
    vec3 dp = wp - uBurstPos;
    float w = exp(-dot(dp, dp) / (uBurstR * uBurstR));
    vec3 dir = dp / max(length(dp), 1e-4);
    vel += dir * (uBurstAmt * w) + vec3(0.0, uBurstUp * w, 0.0);
  }

  // Vortex ring. A rising blob only mushrooms if its cap rolls outward and
  // under, and that roll is circulation the solver has no reason to invent:
  // a purely radial impulse just spreads and dies. So the blast seeds a
  // torus of poloidal circulation — up through the middle, out over the top,
  // down the outside — which is the mushroom.
  if (uBurstRing > 0.0) {
    vec3 dp = wp - uBurstPos;
    float rxz = length(dp.xz);
    vec3 er = rxz > 1e-4 ? vec3(dp.x, 0.0, dp.z) / rxz : vec3(1.0, 0.0, 0.0);
    vec3 s = dp - er * uBurstRingR;          // offset from the ring core
    float ls = length(s);
    if (ls > 1e-4) {
      float core = uBurstRingR * 0.9;
      float w = exp(-(ls * ls) / (core * core));
      vec3 omega = cross(vec3(0.0, 1.0, 0.0), er) * uBurstRing;
      vel += cross(omega, s / max(ls, 1e-4)) * w;
    }
  }

  float m = length(vel);
  if (m > uMaxVel) vel *= uMaxVel / m;
  gl_FragColor = vec4(vel, 0.0);
}`;

// Foam (aerated water) injection from the moving paddle and bursts.
export const INJECT_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uFoam;
uniform float uDt;
uniform float uTime;
uniform float uFoamGain;
uniform float uPaddleOn;
uniform vec3 uPaddlePos;
uniform vec3 uPaddleVelW;   // world units/s
uniform vec3 uPaddleAngVel; // rad/s, world axes
uniform vec3 uPaddleHalf;
uniform mat3 uPaddleRot;
uniform int uBarrelCount;
uniform vec4 uBarrels[6];
uniform vec4 uBarrelVels[6];
uniform vec3 uBurstPos;
uniform float uBurstFoam;
uniform float uBurstR;
uniform vec3 uEmitPos;      // world, sits on the floor
uniform float uEmitR;       // world radius of the mouth
uniform float uEmitRate;    // foam per second at the centre
uniform float uSurfaceY;
uniform float uTank;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  float foam = fetchVox(uFoam, v).x;
  vec3 wp = (vec3(v) + 0.5) / uNf * 2.0 - 1.0;

  if (uPaddleOn > 0.5) {
    // aeration follows the local rigid-body speed, so a paddle spinning in
    // place foams at its sweeping edges, not at its still centre
    float speed = min(length(uPaddleVelW + cross(uPaddleAngVel, wp - uPaddlePos)), 3.0);
    if (speed > 0.02) {
      float d = sdBox(uPaddleRot * (wp - uPaddlePos), uPaddleHalf);
      float w = 1.0 - smoothstep(0.0, 0.14, d);
      float churn = 0.45 + 1.2 * noise3(wp * 14.0 + vec3(0.0, uTime * 2.1, uTime * 1.3));
      foam += w * uFoamGain * speed * churn * uDt;
    }
  }

  // each plunging barrel drags an air cavity: entrainment happens in a capsule
  // wake trailing opposite its motion, strongest at the trailing face and
  // fading down the tail
  for (int i = 0; i < 6; i++) {
    if (i >= uBarrelCount) break;
    float bs = length(uBarrelVels[i].xyz);
    if (bs > 0.05) {
      vec3 dir = uBarrelVels[i].xyz / bs;
      vec3 ba = -dir * 0.4;                       // tail, world units
      vec3 pa = wp - uBarrels[i].xyz;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      float dseg = length(pa - ba * h) - 0.055;
      float w = (1.0 - smoothstep(0.0, 0.10, dseg)) * (1.0 - 0.55 * h);
      // Fine ACROSS the wake and stretched ALONG it, so entrainment reads as
      // streaks trailing the barrel. Isotropic noise at this frequency spans
      // barely two cells across a wake this narrow, so at any one height its
      // value was near enough uniform across the column — and a barrel
      // sinking at a steady rate stamped that height-varying value down the
      // trail as a ladder of evenly spaced discs. Barrels always fall, so the
      // axis to stretch is y; drifting the pattern sideways rather than along
      // the fall keeps the deposit's phase from sliding down the trail too.
      float churn = 0.4 + 1.3 * noise3(wp * vec3(26.0, 7.0, 26.0)
                                     + vec3(uTime * 1.9, 0.0, uTime * 2.3));
      foam += w * uFoamGain * min(bs, 3.0) * churn * 1.4 * uDt;
    }
  }

  if (uBurstFoam > 0.0) {
    vec3 dp = wp - uBurstPos;
    float w = exp(-dot(dp, dp) / (uBurstR * uBurstR));
    foam += w * uBurstFoam * (0.6 + 0.8 * noise3(wp * 12.0 + uTime));
  }

  // A diffuser on the floor: a steady stream rather than a one-off puff, so it
  // is rate per second and integrates with dt. The noise is coarse across the
  // mouth and drifts, which is what makes it break into separate strings of
  // bubbles instead of rising as one solid post.
  if (uEmitRate > 0.0) {
    vec3 dp = (wp - uEmitPos) / max(uEmitR, 1e-3);
    float w = exp(-dot(dp, dp));
    float g = 0.35 + 1.3 * noise3(wp * vec3(21.0, 6.0, 21.0)
                                + vec3(uTime * 1.7, uTime * 0.9, uTime * 1.3));
    foam += w * uEmitRate * g * uDt;
  }

  // bubbles that reach the waterline surface and pop; what survives collects
  // in a thin raft just underneath
  foam *= 1.0 - smoothstep(uSurfaceY - 0.008, uSurfaceY + 0.05, wp.y);
  if (any(greaterThan(abs(wp), vec3(uTank)))) foam = 0.0;
  gl_FragColor = vec4(min(foam, 4.0), 0.0, 0.0, 0.0);
}`;

export const CURL_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 xp = fetchVox(uVel, v + ivec3(1, 0, 0)).xyz, xm = fetchVox(uVel, v - ivec3(1, 0, 0)).xyz;
  vec3 yp = fetchVox(uVel, v + ivec3(0, 1, 0)).xyz, ym = fetchVox(uVel, v - ivec3(0, 1, 0)).xyz;
  vec3 zp = fetchVox(uVel, v + ivec3(0, 0, 1)).xyz, zm = fetchVox(uVel, v - ivec3(0, 0, 1)).xyz;
  vec3 curl = 0.5 * vec3(
    (yp.z - ym.z) - (zp.y - zm.y),
    (zp.x - zm.x) - (xp.z - xm.z),
    (xp.y - xm.y) - (yp.x - ym.x));
  gl_FragColor = vec4(curl, length(curl));
}`;

export const CONFINE_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uCurl;
uniform float uDt;
uniform float uEps;
uniform float uMaxVel;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 vel = fetchVox(uVel, v).xyz;
  vec3 eta = 0.5 * vec3(
    fetchVox(uCurl, v + ivec3(1, 0, 0)).w - fetchVox(uCurl, v - ivec3(1, 0, 0)).w,
    fetchVox(uCurl, v + ivec3(0, 1, 0)).w - fetchVox(uCurl, v - ivec3(0, 1, 0)).w,
    fetchVox(uCurl, v + ivec3(0, 0, 1)).w - fetchVox(uCurl, v - ivec3(0, 0, 1)).w);
  float m = length(eta);
  if (m > 1e-5) {
    vec3 curl = fetchVox(uCurl, v).xyz;
    vel += uEps * cross(eta / m, curl) * uDt;
  }
  float s = length(vel);
  if (s > uMaxVel) vel *= uMaxVel / s; // confinement output must stay bounded too
  gl_FragColor = vec4(vel, 0.0);
}`;

export const DIVERGENCE_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  float div = 0.5 * (
    fetchVox(uVel, v + ivec3(1, 0, 0)).x - fetchVox(uVel, v - ivec3(1, 0, 0)).x +
    fetchVox(uVel, v + ivec3(0, 1, 0)).y - fetchVox(uVel, v - ivec3(0, 1, 0)).y +
    fetchVox(uVel, v + ivec3(0, 0, 1)).z - fetchVox(uVel, v - ivec3(0, 0, 1)).z);
  gl_FragColor = vec4(div, 0.0, 0.0, 0.0);
}`;

// Clamped fetch makes out-of-range neighbours read the edge cell, which is
// exactly the Neumann boundary the closed tank needs.
export const JACOBI_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uPrs;
uniform sampler2D uDiv;
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  float s =
    fetchVox(uPrs, v + ivec3(1, 0, 0)).x + fetchVox(uPrs, v - ivec3(1, 0, 0)).x +
    fetchVox(uPrs, v + ivec3(0, 1, 0)).x + fetchVox(uPrs, v - ivec3(0, 1, 0)).x +
    fetchVox(uPrs, v + ivec3(0, 0, 1)).x + fetchVox(uPrs, v - ivec3(0, 0, 1)).x;
  gl_FragColor = vec4((s - fetchVox(uDiv, v).x) / 6.0, 0.0, 0.0, 0.0);
}`;

// Pressure projection + wall condition: velocity may slide along a wall and
// pull away from it, but never point out of the tank.
export const PROJECT_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uPrs;
uniform float uSurfaceY;
uniform float uTank;         // tank half-extent; outside it is solid
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 vel = fetchVox(uVel, v).xyz;
  vel -= 0.5 * vec3(
    fetchVox(uPrs, v + ivec3(1, 0, 0)).x - fetchVox(uPrs, v - ivec3(1, 0, 0)).x,
    fetchVox(uPrs, v + ivec3(0, 1, 0)).x - fetchVox(uPrs, v - ivec3(0, 1, 0)).x,
    fetchVox(uPrs, v + ivec3(0, 0, 1)).x - fetchVox(uPrs, v - ivec3(0, 0, 1)).x);
  // free surface: air above the waterline is still, and water can't flow up
  // through it. This lid is what makes rising plumes mushroom outward.
  float wy = (float(v.y) + 0.5) / uNf * 2.0 - 1.0;
  if (wy > uSurfaceY) {
    gl_FragColor = vec4(0.0);
    return;
  }
  if (wy + 2.0 / uNf > uSurfaceY) vel.y = min(vel.y, 0.0);

  // Tank walls. The grid stays cubic and uniformly spaced — the tank is a box
  // inside it and everything outside is solid — so the finite differences stay
  // isotropic however the tank is resized.
  vec3 wp = (vec3(v) + 0.5) / uNf * 2.0 - 1.0;
  float h = uTank;
  vec3 cell = vec3(2.0 / uNf);
  if (any(greaterThan(abs(wp), vec3(h)))) { gl_FragColor = vec4(0.0); return; }
  if (wp.x - cell.x < -h) vel.x = max(vel.x, 0.0);
  if (wp.x + cell.x > h) vel.x = min(vel.x, 0.0);
  if (wp.y - cell.y < -h) vel.y = max(vel.y, 0.0);
  if (wp.z - cell.z < -h) vel.z = max(vel.z, 0.0);
  if (wp.z + cell.z > h) vel.z = min(vel.z, 0.0);
  gl_FragColor = vec4(vel, 0.0);
}`;

// Per-voxel transmittance toward the light: foam optical depth marched in
// steps, water optical depth exact from the analytic exit distance.
export const LIGHT_FRAG = VOL_FRAG + /* glsl */ `
uniform sampler2D uFoam;
uniform vec3 uLightDir;     // direction light travels, normalized (y < 0)
uniform float uStepLen;     // voxels
uniform float uSigmaFoam;   // extinction per foam unit, per voxel
uniform float uSigmaWater;  // extinction of clear water, per voxel
uniform float uSurfaceY;    // waterline, world units
uniform float uTime;
uniform float uCaustics;

// Interference of a few travelling waves, sharpened into the bright filaments
// sunlight makes after refracting through a rippled surface.
// Iteratively warped domain, then a sharp reciprocal falloff: this is what
// gives caustics their irregular branching filaments instead of the regular
// lattice a sum of sines produces. Both the sample point and the divisors are
// kept away from zero — a 0/0 here turns the whole light volume into NaN.
float caustic(vec2 p, float t) {
  vec2 q = p + 0.137;
  vec2 i = q;
  float c = 0.0;
  const float inten = 0.006;
  for (int n = 0; n < 3; n++) {
    float tn = t * (1.0 - 3.0 / float(n + 1));
    i = q + vec2(cos(tn - i.x) + sin(tn + i.y), sin(tn - i.y) + cos(tn + i.x));
    vec2 d = vec2(sin(i.x + tn), cos(i.y + tn));
    d = sign(d + 1e-6) * max(abs(d), 1e-3) / inten;
    c += 1.0 / max(length(q / d), 1e-4);
  }
  // median-normalised (77 matches this inten and domain scale, measured over
  // the tank footprint): the field averages ~1 with ~10% bright filaments,
  // so turning caustics up redistributes light rather than adding exposure
  return clamp(pow(c / 77.0, 1.15), 0.0, 3.0) / 1.25;
}

void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(1.0); return; }
  vec3 p = vec3(v) + 0.5;
  vec3 dir = -uLightDir; // toward the light
  float od = 0.0;
  // 24 taps this far apart is a coarse comb through a field that has structure
  // at the same spacing, so the sum aliases — and since the sun sits within ten
  // degrees of straight down, every voxel's comb is in step with the one below
  // it and the aliasing lines up into near-exactly horizontal planes. Offset
  // each voxel's march by its own fraction of a step: neighbours then sample
  // different phases, and the terraces become a fine noise that the trilinear
  // light lookup and the raymarch's own integration average away. The offset
  // is a function of the voxel alone, so it is stable frame to frame — an
  // animated one would shimmer.
  float jit = fract(dot(vec3(v), vec3(0.7548776662, 0.5698402909, 0.6180339887)));
  for (int i = 1; i <= 24; i++) {
    vec3 q = p + dir * (uStepLen * (float(i) + jit));
    if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(uNf)))) break;
    od += sampleVol(uFoam, q).x;
  }
  // exact water path to the box exit along dir
  vec3 inv = 1.0 / dir;
  vec3 t1 = (vec3(0.0) - p) * inv;
  vec3 t2 = (vec3(uNf) - p) * inv;
  float tExit = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
  float t = exp(-od * uSigmaFoam * uStepLen - uSigmaWater * max(tExit, 0.0));

  // Caustics belong here rather than in the raymarch: one evaluation per
  // voxel per frame instead of one per march step. Walking back up the light
  // path to the surface is what turns the pattern into descending shafts.
  vec3 wp = (vec3(v) + 0.5) / uNf * 2.0 - 1.0;
  float below = max(uSurfaceY - wp.y, 0.0);
  vec2 cp = wp.xz - uLightDir.xz * (below / max(-uLightDir.y, 1e-3));
  // filaments are sharp just under the surface and wash out with depth
  float sharp = exp(-below * 0.9);
  float c = caustic(cp * 4.5, uTime * 0.35);
  t *= mix(1.0, c, uCaustics * sharp);
  if (!(t > 0.0)) t = 0.0;   // NaN-safe: a poisoned texel would blacken the tank
  gl_FragColor = vec4(min(t, 8.0), 0.0, 0.0, 0.0);
}`;

// -------------------------------------------------------------- raymarch ---

export const RAYMARCH_VERT = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// GLSL3 with explicit MRT outputs: inscattered light and rgb transmittance.
export const RAYMARCH_FRAG = VOL_COMMON + /* glsl */ `
in vec2 vNdc;
layout(location = 0) out vec4 outLight;
layout(location = 1) out vec4 outTrans;

uniform sampler2D uFoamTex;
uniform sampler2D uLightTex;
uniform sampler2D uDepth;
uniform mat4 uInvProjView;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform float uNear, uFar;
uniform int uSteps;
uniform float uFrame;
uniform float uTime;
uniform float uSurfaceY;
uniform vec4 uRipples[4];    // xy = impact centre (world xz), z = start time, w = strength
uniform float uChop;         // surface roughness multiplier
uniform float uDebugFoam;    // 1 = show raw foam density, no lighting
uniform float uTank;         // tank half-extent
uniform vec3 uSunDir;        // direction light travels
uniform vec3 uSunColor;
uniform vec3 uWaterAbsorb;   // per world unit
uniform vec3 uWaterScatter;
uniform float uFoamScatter;
uniform float uFoamAbsorb;
uniform vec3 uAmbientTop;
uniform vec3 uAmbientDeep;

vec2 boxT(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 a = (vec3(-uTank) - ro) * inv;
  vec3 b = (vec3(uTank) - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

// Ocean spectrum, after the Tessendorf/Horvath model Poseidon builds its FFT
// cascades from (github.com/owenyuwono/poseidon). What an FFT buys over a sum
// like this is a continuum of wavenumbers and no tiling; ten components is
// enough to lose the criss-cross of the four plain sines that were here, at a
// price the raymarch can pay per pixel.
//
// Three things carry the look. Amplitude falls as a steep power of wavenumber
// so there is a DOMINANT wave rather than uniform roughness — hold a flat slope
// spectrum and every octave contributes the same tilt, which reads as one rough
// texture with no scale to it. Direction spreads around the wind and the spread
// WIDENS with wavenumber, because short wind waves are far more broadly spread
// than the swell they ride on; comb every scale into one direction and you get
// corduroy rather than sea. And each component runs at its own deep-water
// speed, w = sqrt(g k), so long waves outrun short ones and the field never
// settles into a repeat.
//
// Crest shape is the other half. A sine's crests and troughs are the same
// width; real waves are trochoidal — narrow peaked crests over long shallow
// troughs. An FFT ocean gets that from horizontal (Gerstner) displacement,
// which a height field cannot have, so each component is squared into the same
// profile instead. Cheap, and the silhouette is what the eye reads.
const int WAVE_N = 10;
const float WAVE_K0 = 6.2;        // dominant wavenumber: ~1 unit crest to crest
const float WAVE_STEP = 1.34;     // geometric spacing between components
const float WAVE_FALL = 0.62;     // amplitude decay per step — the spectrum tail
const float WAVE_SCALE = 0.0085;  // overall height, before uChop
const float WAVE_G = 2.4;         // absolute speed; sqrt(g/k) sets the ratios
const float WIND_ANGLE = 0.62;    // radians, the direction the sea runs

// Height and slope together. Taking the normal by finite differences would cost
// four more evaluations of the whole sum; every component's slope falls out of
// the same sin/cos, so the gradient is nearly free and the normal ends up
// cheaper than it was on four sines.
void waveField(vec2 xz, out float h, out vec2 grad) {
  h = 0.0;
  grad = vec2(0.0);
  float k = WAVE_K0;
  float amp = 1.0;
  for (int i = 0; i < WAVE_N; i++) {
    float fi = float(i);
    // golden-angle sequence: directions and phases that never line up, with no
    // texture fetch and no hash
    float jit = fract(fi * 0.6180339887) * 2.0 - 1.0;
    float spread = 0.30 + 1.05 * fi / float(WAVE_N - 1);
    float ang = WIND_ANGLE + jit * spread;
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(d, xz) * k - sqrt(WAVE_G * k) * uTime + fi * 2.3999632;
    float sn = 0.5 + 0.5 * sin(ph);
    // Cubed rather than squared: the higher the power the narrower the crest
    // and the longer the shallow back face, which is the trochoidal profile a
    // Gerstner displacement produces and a sine never can. 2u^3 averages 0.625
    // over a cycle, and subtracting that keeps the mean surface on the
    // waterline instead of sunk below it.
    h += amp * (2.0 * sn * sn * sn - 0.625);
    grad += d * (amp * k * 3.0 * sn * sn * cos(ph));
    k *= WAVE_STEP;
    amp *= WAVE_FALL;
  }
  float sc = uChop * WAVE_SCALE;
  h *= sc;
  grad *= sc;

  // impact rings from barrel entries and bursts, spreading and decaying. The
  // slope keeps only the ring's own term: the envelope's derivative is smaller
  // by the ring frequency and never shows.
  for (int i = 0; i < 4; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    float age = uTime - r.z;
    if (age < 0.0 || age > 7.0) continue;
    vec2 dv = xz - r.xy;
    float dist = length(dv);
    float ring = dist - age * 0.85;                 // expanding wavefront
    float env = r.w * 0.05 * exp(-abs(ring) * 4.5)
              * exp(-age * 0.55) / (1.0 + dist * 1.5);
    h += env * sin(ring * 20.0);
    grad += (dv / max(dist, 1e-4)) * (env * 20.0 * cos(ring * 20.0));
  }
}

float waveH(vec2 xz) {
  float h; vec2 g;
  waveField(xz, h, g);
  return h;
}

// Where the ray meets the DISPLACED surface, rather than its mean plane. A
// flat plane seen near edge-on is a perfectly straight line, which is what made
// the waterline read as a sheet of glass laid across the tank. March the band
// the waves can reach and take the first crossing: a fixed-point solve diverges
// at exactly the grazing angles that matter most here, where near crests stand
// in front of far troughs and the waterline gets its ragged silhouette.
float surfaceT(vec3 ro, vec3 rd, float t0, float t1, float flatT) {
  const float A = 0.17;   // bound on |waveH| across the chop and ripple ranges
  float ia = (uSurfaceY + A - ro.y) / rd.y;
  float ib = (uSurfaceY - A - ro.y) / rd.y;
  float ta = max(min(ia, ib), t0);
  float tb = min(max(ia, ib), t1);
  if (tb <= ta) return flatT;
  float dt = (tb - ta) / 20.0;
  float tp = ta;
  vec3 q = ro + rd * ta;
  float fp = q.y - uSurfaceY - waveH(q.xz);
  for (int i = 1; i <= 20; i++) {
    float t = ta + dt * float(i);
    q = ro + rd * t;
    float f = q.y - uSurfaceY - waveH(q.xz);
    if (f * fp <= 0.0) {
      float dn = fp - f;
      return tp + (t - tp) * (abs(dn) > 1e-8 ? clamp(fp / dn, 0.0, 1.0) : 0.0);
    }
    tp = t; fp = f;
  }
  return flatT;
}

vec3 waveNormal(vec2 xz) {
  float h; vec2 g;
  waveField(xz, h, g);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main() {
  vec4 far4 = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 rd = normalize(far4.xyz / far4.w - uCamPos);
  vec3 ro = uCamPos;

  vec2 tb = boxT(ro, rd);
  float t0 = max(tb.x, 0.0), t1 = tb.y;

  float tOpaque = 1e9;
  float d = texture2D(uDepth, vNdc * 0.5 + 0.5).x;
  if (d < 1.0) {
    float dist = (uNear * uFar) / (uFar - d * (uFar - uNear));
    tOpaque = dist / max(dot(rd, uCamFwd), 1e-4);
    t1 = min(t1, tOpaque);
  }

  outLight = vec4(0.0, 0.0, 0.0, 1.0);
  outTrans = vec4(1.0);
  if (t1 <= t0) return;

  // --- free surface ---------------------------------------------------------
  // Water occupies y < uSurfaceY. Clip the march to that half-space, and where
  // the view ray actually crosses the waterline, shade it: sun glint off the
  // ripples, a Fresnel rim, and any foam raft floating there.
  vec3 surfaceL = vec3(0.0);
  float surfMirror = 0.0;     // >0 when the march is drawing a reflection
  if (abs(rd.y) > 1e-5) {
    float tS = surfaceT(ro, rd, t0, t1, (uSurfaceY - ro.y) / rd.y);
    if (ro.y > uSurfaceY) {
      if (rd.y >= 0.0 || tS >= t1) {
        t1 = t0;                       // ray stays in the air above the water
      } else if (tS > t0) {
        vec3 ps = ro + rd * tS;
        float wh; vec2 wg;
        waveField(ps.xz, wh, wg);
        vec3 nrm = normalize(vec3(-wg.x, 1.0, -wg.y));
        float cap = smoothstep(0.75, 2.1, length(wg));
        vec3 hv = normalize(-uSunDir - rd);
        // sharp glint plus a broad sheen; the room is black, so what the
        // surface reflects is mostly nothing — that darkness is the realism
        float spec = pow(max(dot(nrm, hv), 0.0), 220.0) * 2.6
                   + pow(max(dot(nrm, hv), 0.0), 24.0) * 0.12;
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-rd, nrm), 0.0), 5.0);
        float raft = smoothstep(0.12, 1.1, sampleVol(uFoamTex,
          (vec3(ps.x, uSurfaceY - 0.04, ps.z) * 0.5 + 0.5) * uNf).x);
        surfaceL = uSunColor * spec
                 + fres * vec3(0.012, 0.035, 0.055)
                 + max(raft, cap) * vec3(0.34, 0.45, 0.53);
        // refract the view ray as it enters the water
        vec3 rr = refract(rd, nrm, 1.0 / 1.333);
        if (dot(rr, rr) > 0.0) {
          ro = ps;
          rd = normalize(rr);
          vec2 nb = boxT(ro + rd * 1e-3, rd);
          t0 = max(nb.x, 0.0) + 1e-3;
          t1 = nb.y;
          if (tOpaque < 1e8) t1 = min(t1, max(tOpaque - tS, 0.0));
        } else {
          t1 = t0;
        }
      }
    } else if (rd.y > 0.0 && tS > t0 && tS < t1) {
      // Looking up from below. Inside Snell's window the surface is a window
      // onto a dark room; outside it the surface is a MIRROR — and a mirror of
      // the tank itself, so the ceiling should carry the plumes and the floor
      // upside down. A flat grey card stood in for that, and at a near-level
      // view like this the ceiling is most of what you see.
      vec3 ps = ro + rd * tS;
      float wh; vec2 wg;
      waveField(ps.xz, wh, wg);
      vec3 nrm = normalize(vec3(-wg.x, 1.0, -wg.y));
      // Whitecaps. Poseidon draws foam where the displacement Jacobian folds; a
      // height field has no fold to test, but the steepest faces are the ones
      // that would, so slope stands in for it. This is what puts white on the
      // crests rather than an even scum over the whole surface.
      float cap = smoothstep(0.75, 2.1, length(wg));
      float cosI = max(dot(rd, nrm), 0.0);
      float sinT2 = 1.333 * 1.333 * (1.0 - cosI * cosI);
      float raft = smoothstep(0.10, 1.0, sampleVol(uFoamTex,
        (vec3(ps.x, uSurfaceY - 0.04, ps.z) * 0.5 + 0.5) * uNf).x);
      float mirror = smoothstep(0.80, 1.02, sinT2);
      // through the window: a dark room, plus the sun's disc wobbling with the
      // chop — the thing the eye actually reads the surface by from underneath
      vec3 through = vec3(0.014, 0.038, 0.058);
      vec3 rt = refract(rd, -nrm, 1.333);
      if (dot(rt, rt) > 0.0) {
        through += uSunColor
                 * pow(max(dot(normalize(rt), -uSunDir), 0.0), 600.0) * 2.2;
      }
      surfaceL = through * (1.0 - mirror)
               + max(raft, cap * 0.8)
                 * mix(vec3(0.30, 0.40, 0.48), vec3(0.45, 0.56, 0.64), mirror);
      if (mirror > 0.002) {
        // fold the ray back down and let the same march that draws the water
        // draw its reflection, so the ceiling costs nothing extra to shade
        surfMirror = mirror;
        ro = ps;
        rd = reflect(rd, nrm);
        vec2 nb = boxT(ro + rd * 1e-3, rd);
        t0 = max(nb.x, 0.0) + 1e-3;
        t1 = nb.y;
      } else {
        t1 = tS;
      }
    }
  } else if (ro.y > uSurfaceY) {
    t1 = t0;
  }

  if (t1 <= t0) {
    outLight = vec4(surfaceL, 1.0);
    return;
  }

  float n = float(uSteps);
  float dt = (t1 - t0) / n;
  // sinless hash: stable on mobile GPUs where sin() loses precision
  vec3 jp = fract(vec3(gl_FragCoord.xy, uFrame) * 0.1031);
  jp += dot(jp, jp.zyx + 31.32);
  float jit = fract((jp.x + jp.y) * jp.z);
  float mu = dot(rd, uSunDir);
  float phase = 0.4 + 0.6 * pow(0.5 * (1.0 + mu), 2.0);

  vec3 T = vec3(1.0);
  vec3 L = vec3(0.0);
  float peakFoam = 0.0;
  float t = t0 + jit * dt;
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps || t >= t1) break;
    vec3 p = ro + rd * t;
    vec3 pv = (p * 0.5 + 0.5) * uNf;
    float foam = sampleVol(uFoamTex, pv).x;
    peakFoam = max(peakFoam, foam);
    // render-time erosion: fake sub-grid detail the sim can't resolve
    foam *= 0.60 + 0.80 * noise3(pv * 0.55);
    float lt = sampleVol(uLightTex, pv).x;

    vec3 sigS = uWaterScatter + vec3(uFoamScatter) * foam;
    vec3 sigT = uWaterAbsorb + sigS + vec3(uFoamAbsorb) * foam;

    // ambient falls off with depth below the waterline, not box height
    float h = clamp(1.0 - max(uSurfaceY - p.y, 0.0) / 1.5, 0.0, 1.0);
    vec3 Li = uSunColor * (lt * phase)
            + mix(uAmbientDeep, uAmbientTop, h) * (0.12 + 0.88 * pow(lt, 0.6));

    vec3 aStep = exp(-sigT * dt);
    L += T * sigS * Li * (1.0 - aStep) / max(sigT, vec3(1e-4));
    T *= aStep;
    if (max(T.x, max(T.y, T.z)) < 0.004) { T = vec3(0.0); break; }
    t += dt;
  }
  if (uDebugFoam > 0.5) {
    // raw foam density, no lighting: isolates the simulation from the shading
    outLight = vec4(vec3(peakFoam * 0.8), 1.0);
    outTrans = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (surfMirror > 0.0) {
    // A reflected ray leaves through a wall of the tank, not out into the room,
    // so whatever transmittance it has left lands on the tank's own dim
    // interior. Letting the real background through there is what turned the
    // ceiling into torn black patches wherever the reflection ran clear.
    L += T * mix(uAmbientDeep, uAmbientTop, 0.35) * 1.6;
    // only the part of the surface still inside Snell's window is a window
    outLight = vec4(L * surfMirror + surfaceL, 1.0);
    outTrans = vec4(vec3(1.0 - surfMirror), 1.0);
  } else {
    outLight = vec4(L + surfaceL, 1.0);
    outTrans = vec4(T, 1.0);
  }
}`;

// ------------------------------------------------------------- composite ---

export const COMPOSITE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uVolLight;
uniform sampler2D uVolTrans;
void main() {
  vec3 col = texture2D(uScene, vUv).rgb * texture2D(uVolTrans, vUv).rgb
           + texture2D(uVolLight, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
}`;

export const BRIGHT_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(uThreshold, uThreshold * 2.0 + 0.15, l);
  gl_FragColor = vec4(c * w, 1.0);
}`;

export const BLUR_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir; // texel-scaled direction
void main() {
  vec3 c = texture2D(uSrc, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
  c += (texture2D(uSrc, vUv + o1).rgb + texture2D(uSrc, vUv - o1).rgb) * 0.3162162162;
  c += (texture2D(uSrc, vUv + o2).rgb + texture2D(uSrc, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

export const POST_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform float uExposure;
uniform float uTime;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec3 col = texture2D(uSrc, vUv).rgb;
  col += texture2D(uBloomA, vUv).rgb * 0.28 + texture2D(uBloomB, vUv).rgb * 0.38;

  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.32 * dot(q, q) * 2.2;         // vignette
  col = aces(col * uExposure);
  col += (hash12(vUv * 913.7 + fract(uTime) * 71.3) - 0.5) * 0.012; // grain
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------- particles ---

// Position texture: xyz = world position, w = remaining life (s).
// Dead particles respawn in the paddle's churn volume.
export const PARTICLE_UPDATE_FRAG = VOL_COMMON + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform float uTime;
uniform float uInit;
uniform vec3 uPaddlePos;
uniform float uPaddleSpeed;
uniform float uSurfaceY;
uniform float uRise;   // world units/s
uniform float uTank;   // tank half-extent

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uPos, fc, 0);
  vec3 seed = vec3(fc, uTime);

  if (uInit > 0.5) {
    vec3 r = hash33(seed);
    gl_FragColor = vec4(r * 1.7 - 0.85, fract(r.x * 13.7) * 6.0);
    return;
  }

  vec3 p = s.xyz;
  float life = s.w - uDt;
  if (life <= 0.0 || any(greaterThan(abs(p), vec3(uTank * 0.995)))) {
    vec3 r = hash33(seed);
    // respawn near the paddle; more eagerly the faster it moves
    p = clamp(uPaddlePos + (r * 2.0 - 1.0) * 0.34, vec3(-uTank * 0.98), vec3(uTank * 0.98));
    life = 2.5 + 4.0 * fract(r.y * 7.31);
    if (uPaddleSpeed < 0.05 && fract(r.z * 5.17) > 0.15) life = -0.001;
  } else {
    vec3 pv = (p * 0.5 + 0.5) * uNf;
    vec3 v = sampleVol(uVel, pv).xyz / (uNf * 0.5); // world units/s
    vec3 jig = hash33(p * 37.0 + uTime) - 0.5;
    // bubbles rise on their own and wobble as they go
    float wob = sin(uTime * 5.5 + s.w * 11.0) * 0.035;
    p += (v + jig * 0.04 + vec3(wob, uRise, wob * 0.6)) * uDt;
    p = clamp(p, vec3(-uTank * 0.995), vec3(uTank * 0.995));
  }
  if (p.y > uSurfaceY - 0.012) life = -0.001; // burst at the surface
  gl_FragColor = vec4(p, life);
}`;

export const PARTICLE_VERT = VOL_COMMON + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uFoamTex;
uniform sampler2D uLightTex;
uniform int uTexSize;
uniform float uPointScale; // px at distance 1
uniform vec3 uPaddlePos;
varying float vAlpha;
varying vec3 vColor;
void main() {
  ivec2 uv = ivec2(gl_VertexID % uTexSize, gl_VertexID / uTexSize);
  vec4 s = texelFetch(uPos, uv, 0);
  if (s.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }

  vec3 pv = (s.xyz * 0.5 + 0.5) * uNf;
  float foam = sampleVol(uFoamTex, pv).x;
  float lt = sampleVol(uLightTex, pv).x;

  // visible on the shell of plumes: fade in with foam, fade out when buried
  float shell = smoothstep(0.02, 0.18, foam) * (1.0 - smoothstep(0.7, 1.8, foam));
  float flick = 0.65 + 0.35 * sin(s.w * 23.0 + float(gl_VertexID));
  // freshly spawned particles cluster on the paddle box; keep them hidden
  // until the flow has carried them away
  float away = smoothstep(0.14, 0.40, distance(s.xyz, uPaddlePos));
  vAlpha = shell * flick * away * min(s.w * 2.0, 1.0);
  vColor = (vec3(0.55, 0.75, 0.9) + vec3(1.0, 0.95, 0.85) * lt * 1.6) * 0.5;

  vec4 mv = viewMatrix * vec4(s.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPointScale / max(-mv.z, 0.2), 0.5, 2.8);
}`;

export const PARTICLE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  float a = vAlpha * smoothstep(0.5, 0.12, d);
  gl_FragColor = vec4(vColor * a * 0.38, 1.0);
}`;

// ---------------------------------------------------------------- meshes ---

export const PADDLE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWp;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const PADDLE_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vWp;
uniform vec3 uSunDir;
uniform float uHover;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWp);
  float fr = pow(1.0 - abs(dot(n, v)), 3.0);
  float diff = max(dot(n, -uSunDir), 0.0);
  vec3 col = vec3(0.016, 0.02, 0.026)
           + diff * vec3(0.035, 0.045, 0.055)
           + fr * vec3(0.22, 0.45, 0.62) * (0.5 + 0.8 * uHover);
  gl_FragColor = vec4(col, 1.0);
}`;

// ?diag=1 liveness probe: reduce the foam and velocity volumes to a 16x16 grid
// of local maxima, cheap enough to run every few frames and read back. A tank
// that renders but never simulates reads exactly zero here, which is otherwise
// indistinguishable from "nothing has aerated the water yet".
export const PROBE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uFoam;
uniform sampler2D uVel;
uniform sampler2D uPrs;
uniform sampler2D uDiv;
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  float mf = 0.0;
  float mv = 0.0;
  float mp = 0.0;
  float md = 0.0;
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      vec2 uv = (cell + vec2(float(i), float(j)) * 0.125) * 0.0625;
      mf = max(mf, texture2D(uFoam, uv).x);
      mv = max(mv, length(texture2D(uVel, uv).xyz));
      mp = max(mp, abs(texture2D(uPrs, uv).x));
      md = max(md, abs(texture2D(uDiv, uv).x));
    }
  }
  gl_FragColor = vec4(mf, mv, mp, md);
}`;

// The barrel: same underwater shading as the paddle, but reading its baked
// base-colour texture rather than a flat tint.
export const BARREL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWp;
varying vec2 vUv;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const BARREL_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vWp;
varying vec2 vUv;
uniform vec3 uSunDir;
uniform sampler2D uMap;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWp);
  vec3 base = texture2D(uMap, vUv).rgb;
  float fr = pow(1.0 - abs(dot(n, v)), 3.0);
  float diff = max(dot(n, -uSunDir), 0.0);
  // Tinted toward the water so it reads as submerged rather than as a sticker
  // floating in front of the tank — but only lightly: the volume in front of
  // it already does most of the tinting, and a heavy tint here left the model
  // a colourless white blob in the plume.
  vec3 col = base * (0.22 + 0.85 * diff) * vec3(0.92, 0.94, 1.0)
           + fr * vec3(0.14, 0.28, 0.40);
  gl_FragColor = vec4(col, 1.0);
}`;
