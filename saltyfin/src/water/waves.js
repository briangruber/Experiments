// The wave train. One table, two evaluators — JS for the boat and the camera,
// GLSL for the surface — so the hull always sits on the crest you can see.
//
// Six Gerstner waves: two long low swells that carry the boat, three mid
// wind-waves that make the chop, one short cross wave that keeps the pattern
// from looking periodic. Amplitudes are small on purpose; this is a sheltered
// tropical bay, not the North Atlantic, and the concept art has a surface you
// can read the reef through.

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
 * Surface height at (x, z). `shore` in 0..1 damps the swell in shallow water so
 * waves flatten as they run up the reef instead of clipping through it.
 */
export function waveHeight(x, z, t, windScale = 1, shore = 1) {
  let y = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const [dx, dz, L, amp, steep, spd] = WAVES[i];
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k) * spd;
    const phase = k * (nx * x + nz * z) - omega * t;
    y += Math.sin(phase) * amp * windScale * shore;
  }
  return y;
}

/** Analytic normal of the same field. `out` is any {x,y,z}. */
export function waveNormal(x, z, t, out, windScale = 1, shore = 1) {
  let dx = 0, dz = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const [wx, wz, L, amp, steep, spd] = WAVES[i];
    const len = Math.hypot(wx, wz) || 1;
    const nx = wx / len, nz = wz / len;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k) * spd;
    const phase = k * (nx * x + nz * z) - omega * t;
    const c = Math.cos(phase) * amp * windScale * shore * k;
    dx += c * nx;
    dz += c * nz;
  }
  const inv = 1 / Math.hypot(dx, 1, dz);
  out.x = -dx * inv; out.y = 1 * inv; out.z = -dz * inv;
  return out;
}

/**
 * GLSL for the same train. Declare `uniform vec4 uWaveA[6];` and
 * `uniform vec4 uWaveB[6];` and fill them from packWaves().
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
