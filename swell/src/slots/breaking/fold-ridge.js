export const meta = {
  slot: 'breaking',
  id: 'fold-ridge',
  title: 'Jacobian fold with an advected raft',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Breaks where the horizontal Jacobian says the surface is folding, biased to the ' +
    'forward face and broken up by wind-stretched clump noise. The trailing raft is ' +
    'recovered statelessly by re-sampling the wave field a few seconds upwind and in ' +
    'the past, so foam sits behind crests instead of on them. In the surf zone the ' +
    'depth-limited breaker index takes over and the whole wave goes white.',
};

export const knobs = {
  foamDrift: 0.55,       // m/s the raft slides downwind after it is born
  foamHistory: 2,        // extra wave-field samples used to age the raft (0 = none)
  foamHistoryWaves: 14,  // trains used in those samples; the long ones do the breaking
  foamGamma: 0.72,       // breaker index H/d at which shallow water forces a break
  foamClumpOctaves: 4,
};

export const schema = [
  ['foamDrift', 0, 3, 0.01, 'm/s'],
  ['foamHistory', 0, 3, 1, 'taps'],
  ['foamHistoryWaves', 4, 48, 1, ''],
  ['foamGamma', 0.3, 1.2, 0.005, 'H/d'],
  ['foamClumpOctaves', 1, 6, 1, ''],
];

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
  float drive = max(w.fold, 0.0) * uFoamCoverage;
  drive *= mix(1.0, sat(0.5 + 0.5 * w.face), uFoamFace);

  // Shallow water: once the crest is a fixed fraction of the depth it breaks,
  // whatever the Jacobian thinks. This is the shore break.
  if (uShoreEnabled > 0.5){
    float H = 2.0 * max(w.disp.y, 0.0);
    float gamma = H / max(depth, 0.08);
    drive += smoothstep(uFoamGamma * 0.6, uFoamGamma, gamma) * 1.9 * uFoamCoverage;
    // Anything still wet on dry-ish sand is swash, and swash is white.
    drive += smoothstep(1.2, 0.15, depth) * 0.7 * uFoamCoverage;
  }
  return drive;
}

float sw_coverageAt(Wave w, vec2 p, float t, float depth, float footprint){
  float drive = sw_breakDrive(w, depth);
  float clump = sw_foamClump(p, t, footprint);
  return sat(smoothstep(uFoamThreshold,
                        uFoamThreshold + max(uFoamSoftness, 0.01),
                        drive * (0.5 + 1.05 * clump)));
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
