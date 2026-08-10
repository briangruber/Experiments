// The wave train. One table, two evaluators — JS for the boat and the camera,
// GLSL for the surface — so the hull always sits on the crest you can see.
//
// Six Gerstner waves: two long low swells that carry the boat, three mid
// wind-waves that make the chop, one short cross wave that keeps the pattern
// from looking periodic. The amplitudes in the table are the SHELTERED ones —
// what the bay does over the reef. Offshore each wave is scaled up by its own
// depth ramp (WAVE_DEEP / waveWeights below), because the player asked for the
// sea to get rougher as it deepens and a single flat train cannot do that.

export const WAVE_COUNT = 6;

// dirX, dirZ, wavelength (m), amplitude (m), steepness (0..1), speed scale
export const WAVES = [
  [0.00, -1.00, 46.0, 0.185, 0.62, 1.00],
  [0.62, -0.78, 31.0, 0.125, 0.55, 0.94],
  [-0.48, -0.88, 18.5, 0.072, 0.48, 1.10],
  [0.88, -0.47, 11.2, 0.041, 0.42, 1.22],
  [-0.92, -0.39, 6.7, 0.023, 0.36, 1.35],
  [0.34, 0.94, 4.1, 0.013, 0.30, 1.48],
];

// --- the depth ramp --------------------------------------------------------
// k, omega and steepness are baked into the surface shader's node graph as
// literals (waterMaterial.js resolves packWaves() once at build time, and
// folding a runtime value in as a literal would rebuild the material — the one
// thing the pipeline cache cannot afford). So the ONLY per-wave quantity that
// can vary at runtime is amplitude, and "rougher offshore" has to be done by
// reweighting the six-component spectrum rather than by lengthening the waves.
//
// That turns out to be the physical answer anyway. A wave stops feeling the
// bottom at d = L/2 (kd = pi) and is fully shallow-water at d = L/20, so each
// component gets its own ramp between its own two depths — nothing invented:
//   46.0 m -> 2.30-23.0    31.0 -> 1.55-15.5    18.5 -> 0.93-9.3
//   11.2   -> 0.56-5.6      6.7 -> 0.34-3.4      4.1 -> 0.20-2.05
// The long swell gains most because the shelf is what kills it, so the
// effective wavelength dips to ~35 m at the reef edge and climbs to ~40 m
// offshore while significant height goes 0.68 m (flat, everywhere) to
// 0.19 / 0.71 / 1.17 / 1.72 / 1.77 m at 1 / 3 / 10 / 20 / 30 m of water.
//
// Every lower endpoint sits inside the surf zone, where `shore` is already
// crushing the train, so the ramp is a deliberate no-op inshore: the harbour,
// the dock, the moored sailboat and the dories float on exactly the water they
// floated on before (Hs at 1 m is 0.19 m with and without it).
export const WAVE_DEEP = [2.8, 2.5, 2.0, 1.6, 1.4, 1.3];
export const WAVE_RAMP = WAVES.map(([, , L]) => [L / 20, L * 0.5]);

// Sum of a*steep*k over the shipped table — the "steepness budget" the crest
// foam threshold in waterMaterial.js was tuned against. Exported so the shader
// can partially normalise the Gerstner Jacobian by it offshore instead of
// turning the deep water to milk. 0.064741 today.
export const WAVE_Q_REF = WAVES.reduce(
  (s, [, , L, amp, steep]) => s + amp * steep * ((2 * Math.PI) / L), 0);

/**
 * Per-wave amplitude weights at one point. `shore` is the existing 0..1 surf
 * damp; `gain` is the master 0..1 knob (a uniform on the GPU side) so the whole
 * depth ramp can be A/B'd without a rebuild — at 0 this returns `shore` six
 * times, i.e. exactly the train that shipped before.
 *
 * `out` is a length-6 array, returned, so the hot path allocates nothing.
 */
export function waveWeights(depth, shore, out, gain = 1, deep = WAVE_DEEP) {
  for (let i = 0; i < WAVE_COUNT; i++) {
    const r = WAVE_RAMP[i];
    let t = (depth - r[0]) / (r[1] - r[0]);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    t = t * t * (3 - 2 * t);                       // the same smoothstep the shader uses
    out[i] = shore * (1 + (deep[i] - 1) * t * gain);
  }
  return out;
}

const G = 9.81;

/** Packed for the shader: vec4(dirX, dirZ, k, amplitude) and vec4(steep, omega, speed, _) */
export function packWaves(windScale = 1, chopScale = 1) {
  const a = new Float32Array(WAVE_COUNT * 4);
  const b = new Float32Array(WAVE_COUNT * 4);
  for (let i = 0; i < WAVE_COUNT; i++) {
    const [dx, dz, L, amp, steep, spd] = WAVES[i];
    const len = Math.hypot(dx, dz) || 1;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k) * spd;
    a[i * 4 + 0] = dx / len;
    a[i * 4 + 1] = dz / len;
    a[i * 4 + 2] = k;
    a[i * 4 + 3] = amp * windScale;
    b[i * 4 + 0] = steep * chopScale;
    b[i * 4 + 1] = omega;
    b[i * 4 + 2] = spd;
    b[i * 4 + 3] = 0;
  }
  return { a, b };
}

/**
 * Surface height at (x, z). `shore` damps the swell in shallow water so waves
 * flatten as they run up the reef instead of clipping through it. It is either
 * a single 0..1 number — the pre-ramp behaviour, still used by callers that
 * have no depth to hand — or a length-6 array of per-wave weights from
 * waveWeights(), which is what water/surface.js passes so the CPU and the
 * vertex shader scale each component identically.
 */
export function waveHeight(x, z, t, windScale = 1, shore = 1) {
  const w = typeof shore === 'number' ? null : shore;
  let y = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const [dx, dz, L, amp, steep, spd] = WAVES[i];
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k) * spd;
    const phase = k * (nx * x + nz * z) - omega * t;
    y += Math.sin(phase) * amp * windScale * (w ? w[i] : shore);
  }
  return y;
}

/** Analytic normal of the same field. `out` is any {x,y,z}. */
export function waveNormal(x, z, t, out, windScale = 1, shore = 1) {
  const wt = typeof shore === 'number' ? null : shore;
  let dx = 0, dz = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const [wx, wz, L, amp, steep, spd] = WAVES[i];
    const len = Math.hypot(wx, wz) || 1;
    const nx = wx / len, nz = wz / len;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k) * spd;
    const phase = k * (nx * x + nz * z) - omega * t;
    const c = Math.cos(phase) * amp * windScale * (wt ? wt[i] : shore) * k;
    dx += c * nx;
    dz += c * nz;
  }
  const inv = 1 / Math.hypot(dx, 1, dz);
  out.x = -dx * inv; out.y = 1 * inv; out.z = -dz * inv;
  return out;
}

/**
 * GLSL for the same train, kept for the raw-WebGL path. It takes a SCALAR
 * shore, i.e. the pre-ramp train; the shipped node material unrolls the six
 * waves itself and carries the per-wave weights as two varyings, because the
 * ramp needs a different multiplier per component and a vec4 array cannot hold
 * one without a uniform upload per frame.
 *
 * Declare `uniform vec4 uWaveA[6];` and `uniform vec4 uWaveB[6];` and fill them
 * from packWaves().
 *
 *   gerstner(pos.xz, time, windScale, shore)  ->  vec3(offsetX, height, offsetZ)
 *   gerstnerNormal(...)                       ->  vec3 world normal
 */
export const WAVES_GLSL = /* glsl */`
#define WAVE_COUNT 6
uniform vec4 uWaveA[WAVE_COUNT];   // dir.xy, k, amplitude
uniform vec4 uWaveB[WAVE_COUNT];   // steepness, omega, speed, _

// Horizontal pinch plus vertical displacement — the crest sharpening that makes
// a swell read as water rather than as a sine sheet.
vec3 gerstner(vec2 p, float t, float windScale, float shore){
  vec3 acc = vec3(0.0);
  for(int i=0;i<WAVE_COUNT;i++){
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].z;
    float a = uWaveA[i].w * windScale * shore;
    float steep = uWaveB[i].x;
    float phase = k*dot(d, p) - uWaveB[i].y*t;
    float s = sin(phase), c = cos(phase);
    acc.y += a * s;
    acc.xz += d * (steep * a * c);
  }
  return acc;
}

vec3 gerstnerNormal(vec2 p, float t, float windScale, float shore){
  vec2 grad = vec2(0.0);
  for(int i=0;i<WAVE_COUNT;i++){
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].z;
    float a = uWaveA[i].w * windScale * shore;
    float phase = k*dot(d, p) - uWaveB[i].y*t;
    grad += d * (k * a * cos(phase));
  }
  return normalize(vec3(-grad.x, 1.0, -grad.y));
}
`;
