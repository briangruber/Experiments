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
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 p = vec3(v) + 0.5;
  vec3 vel = fetchVox(uVel, v).xyz;
  vec3 mid = p - 0.5 * uDt * vel;
  vec3 q = p - uDt * sampleVol(uVel, mid).xyz;
  gl_FragColor = sampleVol(uSrc, q) * uDissipation;
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
uniform vec3 uBurstPos;
uniform float uBurstAmt;   // voxels/s impulse
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 vel = fetchVox(uVel, v).xyz;
  float foam = fetchVox(uFoam, v).x;
  vec3 wp = (vec3(v) + 0.5) / uNf * 2.0 - 1.0;

  vel.y += uBuoyancy * clamp(foam, 0.0, 2.5) * uDt;

  if (uPaddleOn > 0.5) {
    float d = sdBox(uPaddleRot * (wp - uPaddlePos), uPaddleHalf);
    float w = 1.0 - smoothstep(0.0, 0.18, d);
    // rigid-body velocity of the paddle at this voxel: translation + omega x r
    vec3 target = uPaddleVel + cross(uPaddleAngVel, wp - uPaddlePos) * (uNf * 0.5);
    vel += (target - vel) * (w * min(uDt * 16.0, 1.0));
  }

  if (uBurstAmt > 0.0) {
    vec3 dp = wp - uBurstPos;
    float w = exp(-dot(dp, dp) * 30.0);
    vec3 dir = dp / max(length(dp), 1e-4);
    vel += (dir + vec3(0.0, 0.8, 0.0)) * (uBurstAmt * w);
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
uniform vec3 uBurstPos;
uniform float uBurstFoam;
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

  if (uBurstFoam > 0.0) {
    vec3 dp = wp - uBurstPos;
    foam += exp(-dot(dp, dp) * 26.0) * uBurstFoam;
  }

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
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(0.0); return; }
  vec3 vel = fetchVox(uVel, v).xyz;
  vel -= 0.5 * vec3(
    fetchVox(uPrs, v + ivec3(1, 0, 0)).x - fetchVox(uPrs, v - ivec3(1, 0, 0)).x,
    fetchVox(uPrs, v + ivec3(0, 1, 0)).x - fetchVox(uPrs, v - ivec3(0, 1, 0)).x,
    fetchVox(uPrs, v + ivec3(0, 0, 1)).x - fetchVox(uPrs, v - ivec3(0, 0, 1)).x);
  int n = uNi - 1;
  if (v.x == 0) vel.x = max(vel.x, 0.0); else if (v.x == n) vel.x = min(vel.x, 0.0);
  if (v.y == 0) vel.y = max(vel.y, 0.0); else if (v.y == n) vel.y = min(vel.y, 0.0);
  if (v.z == 0) vel.z = max(vel.z, 0.0); else if (v.z == n) vel.z = min(vel.z, 0.0);
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
void main() {
  ivec3 v = voxelFromFrag();
  if (v.z >= uNi) { gl_FragColor = vec4(1.0); return; }
  vec3 p = vec3(v) + 0.5;
  vec3 dir = -uLightDir; // toward the light
  float od = 0.0;
  for (int i = 1; i <= 24; i++) {
    vec3 q = p + dir * (uStepLen * float(i));
    if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(uNf)))) break;
    od += sampleVol(uFoam, q).x;
  }
  // exact water path to the box exit along dir
  vec3 inv = 1.0 / dir;
  vec3 t1 = (vec3(0.0) - p) * inv;
  vec3 t2 = (vec3(uNf) - p) * inv;
  float tExit = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
  float t = exp(-od * uSigmaFoam * uStepLen - uSigmaWater * max(tExit, 0.0));
  gl_FragColor = vec4(t, 0.0, 0.0, 0.0);
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
  vec3 a = (vec3(-1.0) - ro) * inv;
  vec3 b = (vec3(1.0) - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

void main() {
  vec4 far4 = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far4.xyz / far4.w - uCamPos);
  vec2 tb = boxT(uCamPos, dir);
  float t0 = max(tb.x, 0.0), t1 = tb.y;

  float d = texture2D(uDepth, vNdc * 0.5 + 0.5).x;
  if (d < 1.0) {
    float dist = (uNear * uFar) / (uFar - d * (uFar - uNear));
    t1 = min(t1, dist / max(dot(dir, uCamFwd), 1e-4));
  }

  outLight = vec4(0.0, 0.0, 0.0, 1.0);
  outTrans = vec4(1.0);
  if (t1 <= t0) return;

  float n = float(uSteps);
  float dt = (t1 - t0) / n;
  // sinless hash: stable on mobile GPUs where sin() loses precision
  vec3 jp = fract(vec3(gl_FragCoord.xy, uFrame) * 0.1031);
  jp += dot(jp, jp.zyx + 31.32);
  float jit = fract((jp.x + jp.y) * jp.z);
  float mu = dot(dir, uSunDir);
  float phase = 0.4 + 0.6 * pow(0.5 * (1.0 + mu), 2.0);

  vec3 T = vec3(1.0);
  vec3 L = vec3(0.0);
  float t = t0 + jit * dt;
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps || t >= t1) break;
    vec3 p = uCamPos + dir * t;
    vec3 pv = (p * 0.5 + 0.5) * uNf;
    float foam = sampleVol(uFoamTex, pv).x;
    // render-time erosion: fake sub-grid detail the sim can't resolve
    foam *= 0.60 + 0.80 * noise3(pv * 0.55);
    float lt = sampleVol(uLightTex, pv).x;

    vec3 sigS = uWaterScatter + vec3(uFoamScatter) * foam;
    vec3 sigT = uWaterAbsorb + sigS + vec3(uFoamAbsorb) * foam;

    float h = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 Li = uSunColor * (lt * phase)
            + mix(uAmbientDeep, uAmbientTop, h) * (0.12 + 0.88 * pow(lt, 0.6));

    vec3 aStep = exp(-sigT * dt);
    L += T * sigS * Li * (1.0 - aStep) / max(sigT, vec3(1e-4));
    T *= aStep;
    if (max(T.x, max(T.y, T.z)) < 0.004) { T = vec3(0.0); break; }
    t += dt;
  }
  outLight = vec4(L, 1.0);
  outTrans = vec4(T, 1.0);
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
  if (life <= 0.0 || any(greaterThan(abs(p), vec3(0.99)))) {
    vec3 r = hash33(seed);
    // respawn near the paddle; more eagerly the faster it moves
    p = clamp(uPaddlePos + (r * 2.0 - 1.0) * 0.34, vec3(-0.98), vec3(0.98));
    life = 2.5 + 4.0 * fract(r.y * 7.31);
    if (uPaddleSpeed < 0.05 && fract(r.z * 5.17) > 0.15) life = -0.001;
  } else {
    vec3 pv = (p * 0.5 + 0.5) * uNf;
    vec3 v = sampleVol(uVel, pv).xyz / (uNf * 0.5); // world units/s
    vec3 jig = hash33(p * 37.0 + uTime) - 0.5;
    p += (v + jig * 0.05 + vec3(0.0, 0.03, 0.0)) * uDt;
    p = clamp(p, vec3(-0.995), vec3(0.995));
  }
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
