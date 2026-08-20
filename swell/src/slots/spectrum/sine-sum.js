export const meta = {
  slot: 'spectrum',
  id: 'sine-sum',
  title: 'Plain sine sum',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Eight Gerstner trains on a geometric frequency ladder with hand-picked amplitudes: ' +
    'no spectrum, no shoaling, no refraction. This is what a first pass at an ocean ' +
    'usually is, and it is here as the honest floor of the ladder - fast, cheerful, and ' +
    'visibly wrong in the surf zone.',
};

export const knobs = { sineFalloff: 0.68, sineBase: 26.0 };
export const schema = [
  ['sineFalloff', 0.3, 0.95, 0.01, ''],
  ['sineBase', 4, 120, 0.5, 'm'],
];

export const glsl = /* glsl */`
Wave sw_wavesN(vec2 p, float t, float depth, float footprint, int n){
  Wave w;
  w.disp = vec3(0.0); w.fold = 0.0; w.slope = 0.0; w.face = 0.0; w.subRough = 0.0; w.foldRms = 0.0;
  vec2 dydp = vec2(0.0), Jx = vec2(0.0), Jz = vec2(0.0);
  float baseLen = max(uSineBase, 1.0);
  float amp = 0.055 * baseLen * uAmplitude * sat(uWindSpeed / 12.0);
  int count = clamp(n, 1, 8);

  for (int i = 0; i < 8; i++){
    if (i >= count) break;
    float f = pow(uSineFalloff, float(i));
    float lambda = baseLen * f;
    float k = SW_TAU / lambda;
    float A = amp * f * (i > 2 ? uDetail : 1.0);
    float h = sw_hash(vec2(float(i) * 3.7, 1.9));
    float th = radians(uWindDirDeg) + (h * 2.0 - 1.0) * (1.0 - uSpread) * 1.2;
    vec2 D = vec2(cos(th), sin(th));
    float om = sqrt(9.81 * k);

    float fade = smoothstep(footprint * 1.6, footprint * 5.0, lambda);
    float kaFull = k * A;
    w.subRough += 0.5 * kaFull * kaFull * (1.0 - fade * fade);
    A *= fade;
    if (A < 1e-4) continue;

    vec2 kv = D * k;
    float ph = dot(kv, p) - om * t * uTimeScale + h * SW_TAU;
    float s = sin(ph), c = cos(ph);
    float Q = min(uChoppiness, 0.9 / max(k * A, 1e-4));
    float ka = k * A * Q;
    w.foldRms += 0.5 * ka * ka;
    w.disp.y  += A * c;
    w.disp.xz -= D * (Q * A * s);
    dydp      -= A * s * kv;
    Jx        -= Q * A * D.x * c * kv;
    Jz        -= Q * A * D.y * c * kv;
  }

  vec3 Tx = vec3(1.0 + Jx.x, dydp.x, Jz.x);
  vec3 Tz = vec3(Jx.y, dydp.y, 1.0 + Jz.y);
  w.normal = normalize(cross(Tz, Tx));
  w.fold = 1.0 - ((1.0 + Jx.x) * (1.0 + Jz.y) - Jx.y * Jz.x);
  w.slope = length(dydp);
  w.subRough = sqrt(w.subRough);
  w.foldRms = max(sqrt(w.foldRms), 1e-4);
  w.face = -dot(normalize(dydp + vec2(1e-6)),
                vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg))));
  return w;
}

Wave sw_waves(vec2 p, float t, float depth, float footprint){
  return sw_wavesN(p, t, depth, footprint, int(uWaveCount));
}
`;
