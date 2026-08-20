export const meta = {
  slot: 'spectrum',
  id: 'jonswap-gerstner',
  title: 'JONSWAP Gerstner sum',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'N Gerstner trains carrying a JONSWAP *shape* normalised to the measured energy ' +
    'growth law, log-spaced in ' +
    'frequency. Shallow water is handled properly: Guo dispersion, Green shoaling, ' +
    'Snell refraction toward the beach, and a depth-limited amplitude clamp. Crests ' +
    'get a bound second harmonic so troughs flatten instead of turning into sine waves.',
};

export const knobs = {
  spectrumScale: 1.0,  // derived; see derive() below
  gamma: 3.3,          // JONSWAP peak enhancement
  omegaMax: 9.5,       // rad/s; the short end of the resolved band
  shortSpread: 1.0,    // how much more the short waves fan out than the long ones
  breakerLimit: 0.42,  // amplitude ceiling as a fraction of local depth
};

export const schema = [
  ['gamma', 1, 7, 0.05, ''],
  ['omegaMax', 3, 20, 0.1, 'rad/s'],
  ['shortSpread', 0, 2, 0.01, 'x'],
  ['breakerLimit', 0.1, 0.9, 0.005, 'x depth'],
];

const G = 9.81;

// JONSWAP's alpha fit and the significant-height growth law are separate
// empirical results and they disagree by about 1.7x at moderate fetch. Taking
// alpha at face value makes every sea too big, which is why so many of these
// oceans look like they are shot from a dinghy in a gale.
//
// So: keep JONSWAP's *shape*, and set the total energy from the growth law,
// which is the better attested of the two. The scale factor needs a sum over
// every band, so it is computed here, once per frame, rather than 42 pow() calls
// deep inside the pixel loop.
export function derive(k) {
  const U = Math.max(k.windSpeed, 0.4);
  const F = Math.max(k.fetch, 0.1) * 1000;
  const x = (G * F) / (U * U);

  const fp = 3.5 * (G / U) * Math.pow(Math.min(Math.max(x, 1e2), 1e7), -0.33);
  const omp = 2 * Math.PI * fp;
  const alpha = 0.076 * Math.pow(Math.min(Math.max(x, 1e2), 1e7), -0.22);

  const n = Math.max(1, Math.round(k.waveCount));
  const omLo = omp * 0.55;
  const omHi = Math.max(k.omegaMax, omLo * 1.5);
  const ln = Math.log(omHi / omLo);

  let m0 = 0;
  for (let i = 0; i < n; i++) {
    const om = omLo * Math.exp((ln * (i + 0.5)) / n);
    const dom = (om * ln) / n;
    const sigma = om <= omp ? 0.07 : 0.09;
    const r = Math.exp(-Math.pow(om - omp, 2) / (2 * sigma * sigma * omp * omp));
    const S = ((alpha * G * G) / Math.pow(om, 5)) *
      Math.exp(-1.25 * Math.pow(omp / om, 4)) * Math.pow(k.gamma, r);
    // The short-tail gain is part of the shape, so it is inside the normalisation.
    const detail = 1 + (k.detail - 1) * Math.min(1, Math.max(0, (om - omp) / Math.max(omHi - omp, 1e-3)));
    m0 += S * dom * detail * detail;
  }

  // Dimensionless energy against dimensionless fetch, capped at the fully
  // developed sea. This is the relation the waveHeight metric checks against.
  const eps = Math.min(1.6e-7 * x, 3.64e-3);
  const target = (eps * Math.pow(U, 4)) / (G * G);

  return { spectrumScale: m0 > 1e-12 ? Math.sqrt(target / m0) : 1 };
}

export const glsl = /* glsl */`
const float SW_G = 9.81;
#define SW_MAX_WAVES 96

// --- spectrum ---------------------------------------------------------------

// JONSWAP peak frequency from wind speed and fetch (Hasselmann et al.).
float sw_peakOmega(float U, float fetchM){
  float xhat = clamp(SW_G * fetchM / max(U * U, 0.75), 1.0e2, 1.0e7);
  float fp = 3.5 * (SW_G / max(U, 0.75)) * pow(xhat, -0.33);
  return SW_TAU * fp;
}

float sw_jonswap(float om, float omp, float U, float fetchM){
  float xhat = clamp(SW_G * fetchM / max(U * U, 0.75), 1.0e2, 1.0e7);
  float alpha = 0.076 * pow(xhat, -0.22);
  float sigma = om <= omp ? 0.07 : 0.09;
  float r = exp(-pow(om - omp, 2.0) / (2.0 * sigma * sigma * omp * omp));
  float base = alpha * SW_G * SW_G / pow(max(om, 1e-3), 5.0);
  return base * exp(-1.25 * pow(omp / max(om, 1e-3), 4.0)) * pow(uGamma, r);
}

// --- dispersion -------------------------------------------------------------

// Guo (2002) explicit solution of om^2 = g k tanh(k d). Within ~0.75% of the
// Newton answer everywhere, and no iteration in the inner loop.
float sw_waveNumber(float om, float d){
  float k0 = om * om / SW_G;
  if (d > 400.0 || d * k0 > 12.0) return k0;         // deep enough to skip
  float x = om * sqrt(max(d, 0.02) / SW_G);
  float beta = 2.4908;
  float y = x * x * pow(1.0 - exp(-pow(x, beta)), -1.0 / beta);
  return y / max(d, 0.02);
}

// Green's law: energy flux is conserved as the group slows down.
float sw_shoalGain(float om, float k, float d){
  if (d > 400.0) return 1.0;
  float kd = min(k * d, 12.0);
  float cgDeep = 0.5 * SW_G / max(om, 1e-3);
  float cg = 0.5 * (om / max(k, 1e-5)) * (1.0 + 2.0 * kd / max(sinh(2.0 * kd), 1e-4));
  return sqrt(cgDeep / max(cg, 1e-4));
}

// --- the field --------------------------------------------------------------

Wave sw_wavesN(vec2 p, float t, float depth, float footprint, int n){
  Wave w;
  w.disp = vec3(0.0);
  w.fold = 0.0;
  w.slope = 0.0;
  w.face = 0.0;
  w.subRough = 0.0;
  w.foldRms = 0.0;

  n = clamp(n, 1, SW_MAX_WAVES);
  float U = max(uWindSpeed, 0.4);
  float omp = sw_peakOmega(U, uFetch * 1000.0);
  float omLo = omp * 0.55;
  float omHi = max(uOmegaMax, omLo * 1.5);
  float ln = log(omHi / omLo);
  vec2 windDir = vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg)));
  bool shallow = uShoreEnabled > 0.5;

  vec2  dydp = vec2(0.0);
  vec2  Jx = vec2(0.0);    // d(disp.x)/dp
  vec2  Jz = vec2(0.0);    // d(disp.z)/dp

  for (int i = 0; i < SW_MAX_WAVES; i++){
    if (i >= n) break;
    float fi = (float(i) + 0.5) / float(n);
    float om = omLo * exp(ln * fi);
    float dom = om * ln / float(n);

    // Deterministic per-train jitter: same wave every run, every machine.
    float h1 = sw_hash(vec2(float(i) * 1.7, 3.1));
    float h2 = sw_hash(vec2(float(i) * 5.3, 9.7));

    float S = sw_jonswap(om, omp, U, uFetch * 1000.0);
    float A = sqrt(max(2.0 * S * dom, 0.0)) * uSpectrumScale * uAmplitude;

    // The short tail is its own knob: this is the "texture" of the sea.
    A *= mix(1.0, uDetail, sat((om - omp) / max(omHi - omp, 1e-3)));

    // Short waves fan out further from the wind than long ones do.
    float fan = (1.0 - uSpread) * 1.45
              * (0.45 + 0.55 * uShortSpread * sat((om / omp - 0.6) / 2.5));
    float th = atan(windDir.y, windDir.x) + (h1 * 2.0 - 1.0) * fan;
    vec2 D = vec2(cos(th), sin(th));

    float k = shallow ? sw_waveNumber(om, max(depth, 0.05)) : om * om / SW_G;

    if (shallow){
      A *= sw_shoalGain(om, k, max(depth, 0.05)) * uShoalStrength;

      // Snell: the crest turns to face the beach as it slows.
      float cDeep = SW_G / max(om, 1e-3);
      float cLoc  = om / max(k, 1e-5);
      float sinTh = clamp(D.x * cLoc / max(cDeep, 1e-4), -1.0, 1.0);
      D = normalize(vec2(sinTh, sign(D.y + 1e-6) * sqrt(max(1.0 - sinTh * sinTh, 1e-6))));

      // No wave stands taller than the water it is standing in.
      A = min(A, uBreakerLimit * max(depth, 0.02));
    }

    // Anti-aliasing: a train shorter than a couple of pixels is noise, not
    // detail. What it is not is absent - the slope variance we drop here comes
    // back as microfacet roughness, which is why filtered water still glitters.
    float lambda = SW_TAU / max(k, 1e-5);
    float fade = smoothstep(footprint * 1.6, footprint * 5.0, lambda);
    float kaFull = k * A;
    w.subRough += 0.5 * kaFull * kaFull * (1.0 - fade * fade);
    A *= fade;
    if (A < 1e-4) continue;

    vec2  kv = D * k;
    float ph = dot(kv, p) - om * t * uTimeScale + h2 * SW_TAU;
    float s = sin(ph), c = cos(ph);

    // Per-train steepness ceiling; beyond kA ~ 1 a Gerstner wave ties a knot.
    float Q = min(uChoppiness, 0.9 / max(k * A, 1e-4));

    // Variance of this train's contribution to fold. Phases are independent, so
    // the variances add and the RMS is the root of the sum.
    float ka = k * A * Q;
    w.foldRms += 0.5 * ka * ka;

    w.disp.y  += A * c;
    w.disp.xz -= D * (Q * A * s);
    dydp      -= A * s * kv;
    Jx        -= Q * A * D.x * c * kv;
    Jz        -= Q * A * D.y * c * kv;

    // Bound second harmonic: sharp crests, flat troughs.
    if (uCrestSharpen > 0.001){
      float sh = uCrestSharpen * k * A * A;
      w.disp.y += 0.5 * sh * cos(2.0 * ph);
      dydp     -= sh * sin(2.0 * ph) * kv;
    }
  }

  // Swell rides on top: a narrow, long-period train that does not care what the
  // local wind is doing.
  if (uSwellHeight > 1e-3){
    float om = SW_TAU / max(uSwellPeriod, 1.0);
    float base = atan(sin(radians(uSwellDirDeg)), cos(radians(uSwellDirDeg)));
    for (int j = 0; j < 4; j++){
      float hj = sw_hash(vec2(float(j) * 12.9, 78.2));
      float th = base + (hj * 2.0 - 1.0) * uSwellSpread * 1.2;
      vec2 D = vec2(cos(th), sin(th));
      // Four independent trains whose variances add: a_i = Hs / (4 * sqrt(4/2)),
      // so that 4 * a^2 / 2 = (Hs/4)^2 and the train measures the height it claims.
      float A = uSwellHeight * 0.1767767 * uAmplitude;
      float k = shallow ? sw_waveNumber(om, max(depth, 0.05)) : om * om / SW_G;
      if (shallow){
        A *= sw_shoalGain(om, k, max(depth, 0.05)) * uShoalStrength;
        float cDeep = SW_G / max(om, 1e-3);
        float sinTh = clamp(D.x * (om / max(k, 1e-5)) / max(cDeep, 1e-4), -1.0, 1.0);
        D = normalize(vec2(sinTh, sign(D.y + 1e-6) * sqrt(max(1.0 - sinTh * sinTh, 1e-6))));
        A = min(A, uBreakerLimit * max(depth, 0.02));
      }
      vec2 kv = D * k;
      float ph = dot(kv, p) - om * (t + float(j) * 3.3) * uTimeScale + hj * SW_TAU;
      float s = sin(ph), c = cos(ph);
      float Q = min(uChoppiness, 0.9 / max(k * A, 1e-4));
      w.disp.y  += A * c;
      w.disp.xz -= D * (Q * A * s);
      dydp      -= A * s * kv;
      Jx        -= Q * A * D.x * c * kv;
      Jz        -= Q * A * D.y * c * kv;
      float sh = uCrestSharpen * k * A * A;
      w.disp.y += 0.5 * sh * cos(2.0 * ph);
      dydp     -= sh * sin(2.0 * ph) * kv;
    }
  }

  // Tangent frame straight out of the accumulated Jacobian - no finite
  // differences, so the normal is exact at any footprint.
  vec3 Tx = vec3(1.0 + Jx.x, dydp.x, Jz.x);
  vec3 Tz = vec3(Jx.y,       dydp.y, 1.0 + Jz.y);
  w.normal = normalize(cross(Tz, Tx));

  // Horizontal Jacobian determinant. Below zero the surface has folded over
  // itself, which is exactly where a real wave would be throwing a lip.
  float det = (1.0 + Jx.x) * (1.0 + Jz.y) - Jx.y * Jz.x;
  w.fold = 1.0 - det;
  w.slope = length(dydp);
  w.face = -dot(normalize(dydp + vec2(1e-6)), windDir);
  w.subRough = sqrt(w.subRough);
  w.foldRms = max(sqrt(w.foldRms), 1e-4);
  return w;
}

Wave sw_waves(vec2 p, float t, float depth, float footprint){
  return sw_wavesN(p, t, depth, footprint, int(uWaveCount));
}
`;
