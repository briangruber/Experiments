// Gerstner waves shared by the GPU ocean and CPU buoyancy.

export const GRAVITY = 9.81;

export const WAVES = [
  { dir: [1.00, 0.18], len: 72, amp: 0.42, steep: 0.55, speed: 1.00 },
  { dir: [0.72, -0.69], len: 44, amp: 0.28, steep: 0.52, speed: 1.04 },
  { dir: [-0.35, 0.94], len: 26, amp: 0.16, steep: 0.48, speed: 0.96 },
  { dir: [0.94, 0.34], len: 15, amp: 0.09, steep: 0.44, speed: 1.08 },
  { dir: [-0.82, -0.57], len: 9.0, amp: 0.045, steep: 0.40, speed: 1.02 },
  { dir: [0.31, 0.95], len: 5.2, amp: 0.022, steep: 0.36, speed: 1.06 },
];

const W = WAVES.map((w) => {
  const l = Math.hypot(w.dir[0], w.dir[1]) || 1;
  const dx = w.dir[0] / l;
  const dz = w.dir[1] / l;
  const k = (Math.PI * 2) / w.len;
  const omega = Math.sqrt(GRAVITY * k) * w.speed;
  return [dx, dz, k, w.amp, w.steep * w.amp, omega];
});

export function shelter(px, pz) {
  // Harbour mouth faces +Z; calm glass inside the reef, swell outside.
  const r = Math.hypot(px, pz - 40);
  const t = Math.max(0, Math.min(1, (r - 140) / 220));
  return 0.12 + 0.88 * (t * t * (3 - 2 * t));
}

export function waveDisplace(px, pz, t, out = {}) {
  const shel = shelter(px, pz);
  let x = px, y = 0, z = pz;
  let tx = 0, ty = 0, tz = 0;
  let bx = 0, by = 0, bz = 0;
  for (let i = 0; i < W.length; i++) {
    const [dx, dz, k, amp0, qa0, omega] = W[i];
    const amp = amp0 * shel;
    const qa = qa0 * shel;
    const phase = k * (dx * px + dz * pz) - omega * t;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    x += qa * dx * c;
    z += qa * dz * c;
    y += amp * s;
    const ka = k * amp;
    const kqa = k * qa;
    tx -= kqa * dx * dx * s;
    ty += ka * dx * c;
    tz -= kqa * dx * dz * s;
    bx -= kqa * dz * dx * s;
    by += ka * dz * c;
    bz -= kqa * dz * dz * s;
  }
  tx += 1;
  bz += 1;
  let nx = by * tz - bz * ty;
  let ny = bz * tx - bx * tz;
  let nz = bx * ty - by * tx;
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
  nx *= inv; ny *= inv; nz *= inv;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  out.x = x; out.y = y; out.z = z;
  out.nx = nx; out.ny = ny; out.nz = nz;
  return out;
}

const _s = {};
export function sampleWater(wx, wz, t, out = {}) {
  let gx = wx, gz = wz;
  for (let i = 0; i < 3; i++) {
    waveDisplace(gx, gz, t, _s);
    gx += wx - _s.x;
    gz += wz - _s.z;
  }
  waveDisplace(gx, gz, t, _s);
  out.y = _s.y;
  out.nx = _s.nx; out.ny = _s.ny; out.nz = _s.nz;
  return out;
}

export function waterHeight(wx, wz, t) {
  return sampleWater(wx, wz, t, _s).y;
}

function f(v) {
  const s = Number(v).toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
}

export function waveGLSL() {
  return `
const int WAVE_COUNT = ${W.length};
const vec4 WAVE_A[WAVE_COUNT] = vec4[WAVE_COUNT](
${W.map(([dx, dz, k, amp]) => `  vec4(${f(dx)}, ${f(dz)}, ${f(k)}, ${f(amp)})`).join(',\n')}
);
const vec2 WAVE_B[WAVE_COUNT] = vec2[WAVE_COUNT](
${W.map(([, , , , qa, omega]) => `  vec2(${f(qa)}, ${f(omega)})`).join(',\n')}
);

float waveShelter(vec2 p) {
  return 0.12 + 0.88 * smoothstep(140.0, 360.0, length(p - vec2(0.0, 40.0)));
}

vec3 waveField(vec2 p, float t, float detail, out vec3 nrm, out float crest) {
  float shel = waveShelter(p);
  vec3 pos = vec3(p.x, 0.0, p.y);
  vec3 tang = vec3(1.0, 0.0, 0.0);
  vec3 bino = vec3(0.0, 0.0, 1.0);
  float sharp = 0.0;
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 a = WAVE_A[i];
    vec2 b = WAVE_B[i];
    float fade = clamp((detail - float(i) + 2.0) * 0.5, 0.0, 1.0) * shel;
    float amp = a.w * fade;
    float qa = b.x * fade;
    float phase = a.z * dot(a.xy, p) - b.y * t;
    float c = cos(phase);
    float s = sin(phase);
    pos.x += qa * a.x * c;
    pos.z += qa * a.y * c;
    pos.y += amp * s;
    float ka = a.z * amp;
    float kqa = a.z * qa;
    tang.x -= kqa * a.x * a.x * s;
    tang.y += ka * a.x * c;
    tang.z -= kqa * a.x * a.y * s;
    bino.x -= kqa * a.y * a.x * s;
    bino.y += ka * a.y * c;
    bino.z -= kqa * a.y * a.y * s;
    sharp += ka * max(s, 0.0);
  }
  nrm = normalize(cross(bino, tang));
  if (nrm.y < 0.0) nrm = -nrm;
  crest = sharp;
  return pos;
}
`;
}
