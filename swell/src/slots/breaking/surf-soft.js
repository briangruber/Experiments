export const meta = {
  slot: 'breaking',
  id: 'surf-soft',
  title: 'Fold with a dissolved raft',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: 'fold-ridge',
  summary:
    'fold-ridge with two defects fixed. Its breaking ramp has a fixed width in sigmas, ' +
    'so in the surf zone — where the depth-limited term puts the drive several sigmas ' +
    'past the level everywhere — the whole break saturates and the only thing left is a ' +
    'hard contour where the ramp is crossed. Here the ramp and the noise breakup both ' +
    'widen in proportion to how far past the level the drive has gone. And the raft is ' +
    'combined as a soft union over ages that are jittered by a low-frequency world field, ' +
    'instead of a max over two fixed ages, which was drawing two offset hard-edged copies ' +
    'of the break and reading as contour lines.',
};

export const knobs = {
  foamLevel: 2.5,        // derived from wind speed; see derive() below
  foamSigma: 1.25,       // fitted width of the fold field, in units of its own RMS
  foamDrift: 0.55,
  foamHistory: 2,
  foamHistoryWaves: 14,
  foamGamma: 0.72,
  foamClumpOctaves: 4,
  foamSurfWiden: 1.7,   // how much the ramp widens per sigma of excess drive
  foamAgeSpread: 0.55,  // spread of the jittered tap ages, as a fraction of the span
};

export const schema = [
  ['foamSigma', 0.6, 2.5, 0.01, 'x'],
  ['foamDrift', 0, 3, 0.01, 'm/s'],
  ['foamHistory', 0, 3, 1, 'taps'],
  ['foamHistoryWaves', 4, 48, 1, ''],
  ['foamGamma', 0.3, 1.2, 0.005, 'H/d'],
  ['foamClumpOctaves', 1, 6, 1, ''],
  ['foamSurfWiden', 0, 4, 0.05, 'x'],
  ['foamAgeSpread', 0, 1, 0.01, ''],
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
float sw_foamClump(vec2 p, float t, float footprint){
  vec2 wd = vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg)));
  vec2 q = p * uFoamScale;
  vec2 r = vec2(dot(q, wd), dot(q, vec2(-wd.y, wd.x)));
  r.x *= 1.0 - 0.82 * uFoamStreak;
  r += vec2(t * uFoamScale * uFoamDrift, 0.0);
  float cellsPerPixel = footprint * uFoamScale;
  int oct = int(clamp(uFoamClumpOctaves - floor(log2(max(cellsPerPixel * 2.0, 1.0))), 1.0, 6.0));
  return sw_fbm(r, oct);
}

float sw_breakDrive(Wave w, float depth){
  float drive = max(w.fold, 0.0);
  if (uShoreEnabled > 0.5){
    float H = 2.0 * max(w.disp.y, 0.0);
    float gamma = H / max(depth, 0.08);
    drive += smoothstep(uFoamGamma * 0.55, uFoamGamma * 1.15, gamma) * 1.15 * w.foldRms * uFoamLevel;
    drive += smoothstep(0.9, 0.1, depth) * 0.5 * w.foldRms * uFoamLevel;
  }
  return drive;
}

float sw_coverageAt(Wave w, vec2 p, float t, float depth, float footprint){
  float drive = sw_breakDrive(w, depth) / max(w.foldRms, 1e-4);

  float clump = sw_foamClump(p, t, footprint);
  float level = uFoamLevel + (0.5 - clump) * 1.6 - uFoamFace * w.face * 0.9;

  // How far past the breaking level this water is. In open water it hovers
  // around zero and the ramp below behaves exactly as fold-ridge's did. In the
  // surf zone the depth-limited term drives it to several sigmas everywhere,
  // and a ramp of fixed width then resolves into a single hard contour with
  // solid white on one side of it — the paper-cutout look.
  float excess = max(drive - level, 0.0);
  float widen = 1.0 + uFoamSurfWiden * sat(excess / 3.0);

  // Widening the ramp alone would only blur the contour. The clump field has to
  // widen with it, or there is nothing at that scale for the softer ramp to
  // break the edge up against.
  float coarse = sw_fbm(p * (uFoamScale * 0.34) + vec2(t * 0.015, 0.0), 3);
  level += (0.5 - coarse) * 1.5 * (widen - 1.0);

  float soft = max(uFoamSoftness, 0.01) * 2.0 * widen;
  return sat(smoothstep(level - soft, level + soft, drive));
}

vec2 sw_breaking(Wave w, vec2 p, float t, float depth, float footprint){
  float fresh = sw_coverageAt(w, p, t, depth, footprint);

  float raft = 0.0;
  int taps = int(clamp(uFoamHistory, 0.0, 3.0));
  vec2 wd = vec2(cos(radians(uWindDirDeg)), sin(radians(uWindDirDeg)));
  float span = 2.4 / max(uFoamDecay, 0.02);

  // Ages are jittered by a smooth world-locked field rather than being the same
  // two numbers everywhere. A max over fixed ages draws two rigid copies of the
  // break, offset upwind — which is what the contour lines behind every breaker
  // actually were. The field is low frequency and does not move, so this stays
  // deterministic and does not trade a contour for a shimmer.
  float jitter = sw_fbm(p * 0.021, 3);

  for (int h = 1; h <= 3; h++){
    if (h > taps) break;
    float slot = (float(h) - 0.5) / float(taps);
    float age = span * clamp(slot + (jitter - 0.5) * uFoamAgeSpread / float(taps), 0.02, 1.0);
    vec2 pp = p - wd * (uFoamDrift * age);
    float dh = uShoreEnabled > 0.5 ? sw_waterDepth(pp) : depth;
    Wave wh = sw_wavesN(pp, t - age, max(dh, 0.05), footprint, int(uFoamHistoryWaves));
    float cov = sw_coverageAt(wh, pp, t - age, max(dh, 0.05), footprint);
    // Soft union: each tap covers some of what is left, rather than the
    // whole-or-nothing that max gives.
    raft += (1.0 - raft) * cov * exp(-uFoamDecay * age);
  }

  float coverage = sat(fresh + raft * (1.0 - fresh));
  float freshFrac = coverage > 1e-4 ? sat(fresh / coverage) : 0.0;
  return vec2(coverage, freshFrac);
}
`;
