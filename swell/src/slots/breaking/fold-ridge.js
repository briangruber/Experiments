export const meta = {
  slot: 'breaking',
  id: 'fold-ridge',
  title: 'Jacobian fold with an advected raft',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Breaks where the horizontal Jacobian says the surface is folding, at the level ' +
    'whose exceedance probability equals the whitecap fraction the wind should produce ' +
    '- so coverage tracks wind speed instead of tracking whatever the fold field ' +
    'happened to scale to. Biased to the forward face and broken up by wind-stretched ' +
    'clump noise. The trailing raft is ' +
    'recovered statelessly by re-sampling the wave field a few seconds upwind and in ' +
    'the past, so foam sits behind crests instead of on them. In the surf zone the ' +
    'depth-limited breaker index takes over and the whole wave goes white.',
};

export const knobs = {
  foamLevel: 2.5,        // derived: fold sigmas at which the sea starts breaking
  foamSigma: 1.25,       // fitted width of the fold field, in units of its own RMS
  foamDrift: 0.55,       // m/s the raft slides downwind after it is born
  foamHistory: 2,        // extra wave-field samples used to age the raft (0 = none)
  foamHistoryWaves: 14,  // trains used in those samples; the long ones do the breaking
  foamGamma: 0.72,       // breaker index H/d at which shallow water forces a break
  foamClumpOctaves: 4,
};

export const schema = [
  ['foamSigma', 0.6, 2.5, 0.01, 'x'],
  ['foamDrift', 0, 3, 0.01, 'm/s'],
  ['foamHistory', 0, 3, 1, 'taps'],
  ['foamHistoryWaves', 4, 48, 1, ''],
  ['foamGamma', 0.3, 1.2, 0.005, 'H/d'],
  ['foamClumpOctaves', 1, 6, 1, ''],
];

// Whitecap area fraction from Monahan & O'Muircheartaigh (1980), the empirical
// fit to photographic surveys of the real ocean.
const monahan = (u) => 3.84e-6 * Math.pow(Math.max(u, 0.01), 3.41);

// Normal quantile (Acklam's rational approximation). Given a target coverage,
// this is the level a Gaussian field has to exceed to cover that fraction.
function probit(p) {
  p = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// The fold field is a sum of many independent cosines, so it is close to
// Gaussian, and "what fraction of the sea is breaking" becomes "how far into the
// tail do we cut". Setting the cut from Monahan is what makes coverage a
// function of wind rather than a function of whatever the spectrum normalised
// to. `foamThreshold` then shifts that cut in sigmas, which is a knob that means
// the same thing in every scene.
// The fold field is *close* to Gaussian but not quite: the Jacobian determinant
// carries a quadratic term that skews the upper tail, so thresholding at the
// textbook level lands about 1.25 sigma of width too low and over-foams by 4x.
// Rather than pretend, `foamSigma` is that width, fitted against the measured
// coverage in the two fixtures where Monahan's law is actually calibrated
// (golden-hour at 8.2 m/s and deep-ocean at 11.5 m/s). The whitecap metric is
// what keeps it honest: change the spectrum and this number has to be refitted,
// and the harness will say so.
export function derive(k) {
  const target = Math.min(Math.max(monahan(k.windSpeed) * (k.foamCoverage ?? 1), 1e-6), 0.75);
  return { foamLevel: probit(1 - target) * (k.foamSigma ?? 1.25) + (k.foamThreshold ?? 0) };
}

export const glsl = /* glsl */`
// Clump field, stretched downwind into windrows and filtered by footprint so it
// stops resolving before it starts to shimmer.
float sw_foamClump(vec2 p, float t, float footprint){
  vec2 wd = vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg)));
  vec2 q = p * uFoamScale;
  vec2 r = vec2(dot(q, wd), dot(q, vec2(-wd.y, wd.x)));
  r.x *= 1.0 - 0.82 * uFoamStreak;              // long in the wind direction
  r += vec2(t * uFoamScale * uFoamDrift, 0.0);
  float cellsPerPixel = footprint * uFoamScale;
  int oct = int(clamp(uFoamClumpOctaves - floor(log2(max(cellsPerPixel * 2.0, 1.0))), 1.0, 6.0));
  return sw_fbm(r, oct);
}

// How hard this patch of water is trying to break, before any noise breakup.
float sw_breakDrive(Wave w, float depth){
  float drive = max(w.fold, 0.0);

  // Shallow water: once the crest is a fixed fraction of the depth it breaks,
  // whatever the Jacobian thinks. This is the shore break.
  if (uShoreEnabled > 0.5){
    float H = 2.0 * max(w.disp.y, 0.0);
    float gamma = H / max(depth, 0.08);
    // These are added in fold units and then normalised with everything else, so
    // they are scaled to land well above the breaking level once divided.
    drive += smoothstep(uFoamGamma * 0.6, uFoamGamma, gamma) * 1.9 * w.foldRms * uFoamLevel;
    // Anything still wet on dry-ish sand is swash, and swash is white.
    drive += smoothstep(1.2, 0.15, depth) * 0.9 * w.foldRms * uFoamLevel;
  }
  return drive;
}

float sw_coverageAt(Wave w, vec2 p, float t, float depth, float footprint){
  // Fold in units of its own RMS, so the level below is a number of sigmas.
  float drive = sw_breakDrive(w, depth) / max(w.foldRms, 1e-4);

  // Both modifiers shift the *level* and both are zero-mean across the field, so
  // they change where the foam is without changing how much of it there is —
  // which is what keeps the coverage matching the wind law it was set from.
  float clump = sw_foamClump(p, t, footprint);
  float level = uFoamLevel + (0.5 - clump) * 1.6 - uFoamFace * w.face * 0.9;

  return sat(smoothstep(level - max(uFoamSoftness, 0.01) * 2.0,
                        level + max(uFoamSoftness, 0.01) * 2.0,
                        drive));
}

vec2 sw_breaking(Wave w, vec2 p, float t, float depth, float footprint){
  float fresh = sw_coverageAt(w, p, t, depth, footprint);

  // The raft: where was this water breaking a second or two ago? Re-sampling a
  // truncated wave field is cheaper than carrying a simulation buffer, and it
  // stays exact under scrubbing and seeking, which a buffer does not.
  float raft = 0.0;
  int taps = int(clamp(uFoamHistory, 0.0, 3.0));
  vec2 wd = vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg)));
  for (int h = 1; h <= 3; h++){
    if (h > taps) break;
    float age = (float(h) / float(taps)) * (2.4 / max(uFoamDecay, 0.02));
    vec2 pp = p - wd * (uFoamDrift * age);
    float dh = uShoreEnabled > 0.5 ? sw_waterDepth(pp) : depth;
    Wave wh = sw_wavesN(pp, t - age, max(dh, 0.05), footprint, int(uFoamHistoryWaves));
    float cov = sw_coverageAt(wh, pp, t - age, max(dh, 0.05), footprint);
    raft = max(raft, cov * exp(-uFoamDecay * age));
  }

  float coverage = sat(fresh + raft * (1.0 - fresh));
  // Freshness is what the shading slot uses to tell a bubble raft from a veil.
  float freshFrac = coverage > 1e-4 ? sat(fresh / coverage) : 0.0;
  return vec2(coverage, freshFrac);
}
`;
